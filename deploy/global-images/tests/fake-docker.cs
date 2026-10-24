// Test-only Docker CLI and local HTTP fixture. Never contacts Docker or an LLM.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Web.Script.Serialization;

class FakeDocker {
    static JavaScriptSerializer Json = new JavaScriptSerializer();
    static string Root = Environment.GetEnvironmentVariable("TDAI_DEPLOY_TEST_STATE");
    static string FilePath(string name) { return Path.Combine(Root, name); }
    static bool Flag(string name) { return File.Exists(FilePath(name)); }
    static Dictionary<string, object> ReadObject(string name) {
        return Flag(name) ? Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(FilePath(name))) : new Dictionary<string, object>();
    }
    static void WriteObject(string name, object value) { File.WriteAllText(FilePath(name), Json.Serialize(value), new UTF8Encoding(false)); }
    static string After(string[] args, string option) { int i = Array.IndexOf(args, option); return i < 0 ? "" : args[i + 1]; }

    static int Main(string[] args) {
        if (args[0] == "serve") { Serve(int.Parse(args[1])); return 0; }
        var env = new Dictionary<string, string>();
        for (int i = 0; i < args.Length - 1; i++) {
            if (args[i] != "--env") continue;
            string item = args[++i]; int equals = item.IndexOf('=');
            env[equals < 0 ? item : item.Substring(0, equals)] = equals < 0 ? Environment.GetEnvironmentVariable(item) : item.Substring(equals + 1);
        }
        File.AppendAllText(FilePath("docker.jsonl"), Json.Serialize(new { argv = args, environment = env }) + "\n", new UTF8Encoding(false));
        var containers = ReadObject("containers.json");
        switch (args[0]) {
            case "info":
                if (Flag("daemon-down")) return 1;
                Console.WriteLine(Flag("windows-engine") ? "windows" : "linux"); return 0;
            case "network":
                if (args[1] == "inspect") return Flag("network") ? 0 : 1;
                if (args[1] == "create") File.WriteAllText(FilePath("network"), "created");
                return 0;
            case "container":
                string name = args[2];
                if (!containers.ContainsKey(name)) return 1;
                bool unhealthy = Flag("unhealthy") && File.ReadAllText(FilePath("unhealthy")) == name;
                Console.WriteLine(Json.Serialize(new[] { new { State = new { Status = "running", Health = new { Status = unhealthy ? "unhealthy" : "healthy" } } } }));
                return 0;
            case "run":
                string runName = After(args, "--name");
                if (Flag("fail-run") && File.ReadAllText(FilePath("fail-run")) == runName) {
                    Console.Error.WriteLine("synthetic container start failure"); return 17;
                }
                containers[runName] = args; WriteObject("containers.json", containers);
                Console.WriteLine("fake-container-id"); return 0;
            case "rm":
                containers.Remove(args[args.Length - 1]); WriteObject("containers.json", containers); return 0;
            case "port":
                if (containers.ContainsKey(args[1])) {
                    var options = ((System.Collections.IEnumerable)containers[args[1]]).Cast<object>().Select(x => x.ToString()).ToArray();
                    for (int i = 0; i < options.Length - 1; i++) {
                        if (options[i] == "-p") Console.WriteLine("8096/tcp -> 0.0.0.0:" + options[++i].Split(':')[0]);
                    }
                }
                return 0;
            case "volume":
                return args[1] == "rm" && Flag("fail-volume-rm") ? 18 : 0;
            case "logs": Console.WriteLine("synthetic container log"); return 0;
            case "image": return Flag("missing-image") ? 1 : 0;
            case "pull": return Flag("fail-pull") ? 19 : 0;
            case "exec": return 0;
        }
        Console.Error.WriteLine("Unexpected Docker command"); return 2;
    }

    static void Serve(int port) {
        var listener = new TcpListener(IPAddress.Loopback, port);
        listener.Start(); File.WriteAllText(FilePath("server-ready"), "ready");
        while (true) {
            using (var client = listener.AcceptTcpClient()) using (var stream = client.GetStream()) {
                var bytes = new List<byte>(); var buffer = new byte[4096];
                int headerEnd = -1; int length = 0;
                while (true) {
                    int count = stream.Read(buffer, 0, buffer.Length); if (count == 0) break;
                    bytes.AddRange(buffer.Take(count));
                    string message = Encoding.UTF8.GetString(bytes.ToArray());
                    headerEnd = message.IndexOf("\r\n\r\n");
                    if (headerEnd < 0) continue;
                    foreach (string header in message.Substring(0, headerEnd).Split('\n')) {
                        if (header.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase)) length = int.Parse(header.Split(':')[1].Trim());
                    }
                    if (bytes.Count >= headerEnd + 4 + length) break;
                }
                if (headerEnd < 0) continue;
                string request = Encoding.UTF8.GetString(bytes.ToArray());
                string path = request.Split(' ')[1];
                string body = request.Substring(headerEnd + 4);
                File.AppendAllText(FilePath("http.jsonl"), Json.Serialize(new { path = path, body = body }) + "\n");
                int status = 200; string content = "{\"code\":0,\"data\":[]}";
                if (path.EndsWith("/init-admin")) {
                    if (Flag("fail-init")) status = 500;
                    else if (Flag("admin.json")) status = 409;
                    else WriteObject("admin.json", Json.DeserializeObject(body));
                } else if (path.EndsWith("/auth/verify")) {
                    var supplied = Json.Deserialize<Dictionary<string, object>>(body);
                    var admin = ReadObject("admin.json");
                    if (!admin.ContainsKey("user_key") || !supplied["user_key"].Equals(admin["user_key"])) status = 401;
                } else if (Flag("fail-llm")) status = 401;
                byte[] responseBody = Encoding.UTF8.GetBytes(content);
                byte[] responseHeaders = Encoding.ASCII.GetBytes("HTTP/1.1 " + status + " Test\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: " + responseBody.Length + "\r\n\r\n");
                stream.Write(responseHeaders, 0, responseHeaders.Length); stream.Write(responseBody, 0, responseBody.Length);
            }
        }
    }
}
