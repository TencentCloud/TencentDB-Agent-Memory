// Interactive quickstart for the trpc-agent-go adapter of TencentDB Agent
// Memory.
//
// Prerequisites:
//  1. The TencentDB Agent Memory stack is running locally, e.g. via
//     deploy/global-images/start-all.sh from the repository root. The adapter
//     talks to the memory-core gateway, which listens on :8420 by default.
//  2. OPENAI_API_KEY (or another OpenAI-compatible provider configured by
//     editing the model construction below) for the agent's own chat model.
//
// Run:
//
//	cd adapters/trpc-agent-go/example
//	export OPENAI_API_KEY="sk-..."
//	go run . -model deepseek-chat
//
// Then teach it a fact, start a new session, and ask about it:
//
//	You: Remember: my project codename is Apollo Lake.
//	You: /new
//	You: What is my project codename?
package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"trpc.group/trpc-go/trpc-agent-go/agent/llmagent"
	"trpc.group/trpc-go/trpc-agent-go/event"
	memorytencentdb "trpc.group/trpc-go/trpc-agent-go/memory/tencentdb"
	"trpc.group/trpc-go/trpc-agent-go/model"
	"trpc.group/trpc-go/trpc-agent-go/model/openai"
	"trpc.group/trpc-go/trpc-agent-go/runner"
	"trpc.group/trpc-go/trpc-agent-go/session"
	sessioninmemory "trpc.group/trpc-go/trpc-agent-go/session/inmemory"
)

const defaultGatewayURL = "http://127.0.0.1:8420"

var (
	modelName  = flag.String("model", "deepseek-chat", "Chat model name")
	appName    = flag.String("app", "trpc-agent-go-demo", "Application name used for session ownership")
	userID     = flag.String("user", "demo-user", "User ID used for session ownership")
	gatewayURL = flag.String(
		"gateway",
		envOrDefault("TENCENTDB_AGENT_MEMORY_GATEWAY", defaultGatewayURL),
		"TencentDB Agent Memory gateway URL",
	)
	gatewayAPIKey = flag.String(
		"gateway-api-key",
		os.Getenv("TDAI_GATEWAY_API_KEY"),
		"Gateway API key sent as Authorization: Bearer, required when the gateway is started with TDAI_GATEWAY_API_KEY",
	)
	turnWait = flag.Duration(
		"turn-wait",
		2*time.Second,
		"Delay after each turn to let the gateway finish capture/extraction",
	)
)

func main() {
	flag.Parse()
	if os.Getenv("OPENAI_API_KEY") == "" {
		log.Fatal("OPENAI_API_KEY is required")
	}

	// Recall and the long-term memory_search tool are opt-in because the
	// gateway does not enforce per-user/session scoping on those paths. This
	// demo assumes a single-trusted-user local sidecar, so both are enabled.
	memSvc, err := memorytencentdb.NewService(
		memorytencentdb.WithGatewayURL(*gatewayURL),
		memorytencentdb.WithAPIKey(*gatewayAPIKey),
		memorytencentdb.WithRecallEnabled(true),
		memorytencentdb.WithMemorySearchTool(true),
	)
	if err != nil {
		log.Fatalf("create TencentDB Agent Memory service: %v", err)
	}
	defer memSvc.Close()

	ctx := context.Background()
	health, err := memSvc.Health(ctx)
	if err != nil {
		log.Fatalf("TencentDB Agent Memory gateway is not ready (is start-all.sh running?): %v", err)
	}

	chatAgent := llmagent.New(
		"memory-demo-agent",
		llmagent.WithModel(openai.New(*modelName)),
		llmagent.WithDescription("A concise assistant backed by TencentDB Agent Memory."),
		llmagent.WithTools(memSvc.Tools()),
	)

	sessionSvc := sessioninmemory.NewSessionService()
	r := runner.NewRunner(
		*appName,
		chatAgent,
		runner.WithSessionService(sessionSvc),
		// Streams each completed turn to the gateway via POST /capture.
		runner.WithSessionIngestor(memSvc),
		// Injects recalled memory context before each model call (opt-in).
		runner.WithPlugins(memSvc.Plugin()),
	)
	defer r.Close()

	sessionID := fmt.Sprintf("demo-%d", time.Now().Unix())
	fmt.Printf("Model:   %s\n", *modelName)
	fmt.Printf("Gateway: %s (status=%s version=%s)\n", *gatewayURL, health.Status, health.Version)
	fmt.Printf("App:     %s\nUser:    %s\nSession: %s\n", *appName, *userID, sessionID)
	fmt.Println(strings.Repeat("=", 60))
	fmt.Println("Commands: /new (flush + new session), /exit")

	chat := &memoryChat{
		runner:     r,
		sessionSvc: sessionSvc,
		memSvc:     memSvc,
		sessionID:  sessionID,
	}
	if err := chat.start(ctx); err != nil {
		log.Fatalf("chat failed: %v", err)
	}
}

type memoryChat struct {
	runner     runner.Runner
	sessionSvc session.Service
	memSvc     *memorytencentdb.Service
	sessionID  string
}

func (c *memoryChat) start(ctx context.Context) error {
	scanner := bufio.NewScanner(os.Stdin)
	for {
		fmt.Print("\nYou: ")
		if !scanner.Scan() {
			return nil
		}
		input := strings.TrimSpace(scanner.Text())
		if input == "" {
			continue
		}
		switch strings.ToLower(input) {
		case "/exit":
			fmt.Println("Goodbye!")
			return nil
		case "/new":
			if err := c.startNewSession(ctx); err != nil {
				fmt.Printf("Start new session failed: %v\n", err)
			}
			continue
		}
		if err := c.processMessage(ctx, input); err != nil {
			fmt.Printf("Error: %v\n", err)
		}
	}
}

func (c *memoryChat) processMessage(ctx context.Context, input string) error {
	result, err := runOnce(ctx, c.runner, *userID, c.sessionID, input)
	if err != nil {
		return err
	}
	if len(result.toolCalls) > 0 {
		fmt.Printf("Tool calls: %s\n", strings.Join(result.toolCalls, ", "))
	}
	if reply := strings.TrimSpace(result.reply); reply != "" {
		fmt.Printf("Assistant: %s\n", reply)
	}
	if *turnWait > 0 {
		time.Sleep(*turnWait)
	}
	return nil
}

func (c *memoryChat) startNewSession(ctx context.Context) error {
	if err := c.endCurrentSession(ctx); err != nil {
		return err
	}
	c.sessionID = fmt.Sprintf("demo-%d", time.Now().UnixNano())
	fmt.Printf("New session: %s (long-term memories survive across sessions)\n", c.sessionID)
	return nil
}

func (c *memoryChat) endCurrentSession(ctx context.Context) error {
	sess, err := c.sessionSvc.GetSession(ctx, session.Key{
		AppName:   *appName,
		UserID:    *userID,
		SessionID: c.sessionID,
	})
	if err != nil {
		return fmt.Errorf("lookup session: %w", err)
	}
	if sess == nil {
		return fmt.Errorf("session %s not found", c.sessionID)
	}
	return c.memSvc.EndSession(ctx, sess)
}

type runResult struct {
	toolCalls []string
	reply     string
}

func runOnce(ctx context.Context, r runner.Runner, userID, sessionID, input string) (*runResult, error) {
	ch, err := r.Run(ctx, userID, sessionID, model.NewUserMessage(input))
	if err != nil {
		return nil, err
	}
	out := &runResult{}
	seen := make(map[string]struct{})
	for evt := range ch {
		if evt == nil {
			continue
		}
		if evt.Error != nil {
			return nil, fmt.Errorf("runner event error: %s", evt.Error.Message)
		}
		collectResponse(out, seen, evt)
	}
	return out, nil
}

func collectResponse(out *runResult, seen map[string]struct{}, evt *event.Event) {
	if evt == nil || evt.Response == nil {
		return
	}
	for _, choice := range evt.Response.Choices {
		for _, tc := range choice.Message.ToolCalls {
			name := strings.TrimSpace(tc.Function.Name)
			if name == "" {
				continue
			}
			if _, ok := seen[name]; ok {
				continue
			}
			seen[name] = struct{}{}
			out.toolCalls = append(out.toolCalls, name)
		}
		if text := strings.TrimSpace(choice.Message.Content); text != "" {
			out.reply = text
		}
	}
}

func envOrDefault(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
