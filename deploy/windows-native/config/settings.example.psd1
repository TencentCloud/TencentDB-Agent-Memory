@{
  DeploymentMode = "Full"
  Core = @{
    Host = "0.0.0.0"
    Port = 8420
    LlmBaseUrl = "https://llm-upstream.example.com/v1"
    LlmApiKey = ""
    LlmModel = ""
    LlmProtocol = "openai"
    EnableExtraction = $true
    PromptMode = "code"
  }
  Knowledge = @{
    Host = "0.0.0.0"
    Port = 8424
  }
  Panel = @{
    Host = "0.0.0.0"
    Port = 8125
    InstanceId = "default"
    InstanceName = "Local Windows"
  }
  Proxy = @{
    Host = "0.0.0.0"
    Port = 8096
    UpstreamUrl = "https://llm-upstream.example.com/v1"
    UpstreamApiKey = ""
    UpstreamModel = ""
    EnableAuth = $true
    EnableTdai = $true
    EnableSessionInit = $false
  }
}
