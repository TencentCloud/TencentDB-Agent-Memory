package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"trpc.group/trpc-go/trpc-agent-go/event"
	memorytencentdb "trpc.group/trpc-go/trpc-agent-go/memory/tencentdb"
	"trpc.group/trpc-go/trpc-agent-go/model"
	"trpc.group/trpc-go/trpc-agent-go/session"
	"trpc.group/trpc-go/trpc-agent-go/tool"
)

// fakeGateway records the requests the adapter sends to a TencentDB Agent
// Memory gateway so the wiring can be verified end-to-end without the real
// stack. It implements the subset of routes the memory/tencentdb package
// consumes: /health, /capture and /session/end.
type fakeGateway struct {
	server         *httptest.Server
	authorizations chan string
	captures       chan map[string]any
	endSessions    chan map[string]any
}

func newFakeGateway(t *testing.T) *fakeGateway {
	t.Helper()
	gw := &fakeGateway{
		authorizations: make(chan string, 16),
		captures:       make(chan map[string]any, 16),
		endSessions:    make(chan map[string]any, 16),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"status": "ok", "version": "test-gateway"})
	})
	mux.HandleFunc("/capture", func(w http.ResponseWriter, r *http.Request) {
		recordAuthorization(gw.authorizations, r)
		gw.captures <- decodeBody(r)
		writeJSON(w, map[string]any{"l0_recorded": 1, "scheduler_notified": true})
	})
	mux.HandleFunc("/session/end", func(w http.ResponseWriter, r *http.Request) {
		recordAuthorization(gw.authorizations, r)
		gw.endSessions <- decodeBody(r)
		writeJSON(w, map[string]any{"flushed": true})
	})
	gw.server = httptest.NewServer(mux)
	t.Cleanup(gw.server.Close)
	return gw
}

func recordAuthorization(ch chan string, r *http.Request) {
	select {
	case ch <- r.Header.Get("Authorization"):
	default:
	}
}

func decodeBody(r *http.Request) map[string]any {
	defer r.Body.Close()
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	return body
}

func writeJSON(w http.ResponseWriter, payload map[string]any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(payload)
}

func waitRequest(t *testing.T, ch <-chan map[string]any, name string) map[string]any {
	t.Helper()
	select {
	case req := <-ch:
		return req
	case <-time.After(5 * time.Second):
		t.Fatalf("%s request did not arrive within 5s", name)
		return nil
	}
}

func newCaptureSession() *session.Session {
	now := time.Now()
	return &session.Session{
		ID:      "s1",
		AppName: "app",
		UserID:  "user",
		Events: []event.Event{
			{
				ID:        "u1",
				Timestamp: now,
				Response: &model.Response{Choices: []model.Choice{{
					Message: model.NewUserMessage("remember my project codename is Apollo Lake"),
				}}},
			},
			{
				ID:        "a1",
				Timestamp: now.Add(time.Second),
				Response: &model.Response{Choices: []model.Choice{{
					Message: model.NewAssistantMessage("Noted."),
				}}},
			},
		},
	}
}

// TestAdapterWiring verifies the adapter's public contract against a fake
// gateway: health probing, tool exposure, session capture via IngestSession,
// bearer auth on write paths, and session flush via EndSession.
func TestAdapterWiring(t *testing.T) {
	gw := newFakeGateway(t)

	memSvc, err := memorytencentdb.NewService(
		memorytencentdb.WithGatewayURL(gw.server.URL),
		memorytencentdb.WithAPIKey("test-key"),
		memorytencentdb.WithMemorySearchTool(true),
	)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	defer memSvc.Close()

	health, err := memSvc.Health(context.Background())
	if err != nil {
		t.Fatalf("Health: %v", err)
	}
	if health.Status != "ok" || health.Version != "test-gateway" {
		t.Fatalf("unexpected health response: %+v", health)
	}

	toolNames := toolNameSet(memSvc.Tools())
	for _, want := range []string{"tdai_conversation_search", "tdai_memory_search"} {
		if !toolNames[want] {
			t.Fatalf("expected tool %q in Tools(), got %v", want, toolNames)
		}
	}

	sess := newCaptureSession()
	if err := memSvc.IngestSession(context.Background(), sess); err != nil {
		t.Fatalf("IngestSession: %v", err)
	}

	capture := waitRequest(t, gw.captures, "/capture")
	if got := capture["user_content"]; got != "remember my project codename is Apollo Lake" {
		t.Fatalf("unexpected user_content in capture: %v", got)
	}
	if got := capture["assistant_content"]; got != "Noted." {
		t.Fatalf("unexpected assistant_content in capture: %v", got)
	}
	if got := capture["user_id"]; got != "user" {
		t.Fatalf("unexpected user_id in capture: %v", got)
	}
	messages, ok := capture["messages"].([]any)
	if !ok || len(messages) == 0 {
		t.Fatalf("expected non-empty messages in capture, got %v", capture["messages"])
	}

	// EndSession waits for the in-flight capture first, so the ordering of
	// recorded requests is deterministic.
	if err := memSvc.EndSession(context.Background(), sess); err != nil {
		t.Fatalf("EndSession: %v", err)
	}
	endReq := waitRequest(t, gw.endSessions, "/session/end")
	if got := endReq["user_id"]; got != "user" {
		t.Fatalf("unexpected user_id in session/end: %v", got)
	}

	for i := 0; i < 2; i++ {
		select {
		case auth := <-gw.authorizations:
			if auth != "Bearer test-key" {
				t.Fatalf("expected bearer auth on write path, got %q", auth)
			}
		default:
			t.Fatal("expected Authorization header on gateway write requests")
		}
	}
}

func toolNameSet(tools []tool.Tool) map[string]bool {
	names := make(map[string]bool, len(tools))
	for _, tl := range tools {
		if tl != nil && tl.Declaration() != nil {
			names[tl.Declaration().Name] = true
		}
	}
	return names
}
