{{- define "am.labels" -}}
app.kubernetes.io/name: agent-memory
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "am.core" -}}{{ .Release.Name }}-core{{- end -}}
{{- define "am.hub" -}}{{ .Release.Name }}-hub{{- end -}}
{{- define "am.proxy" -}}{{ .Release.Name }}-proxy{{- end -}}
{{- define "am.coreUrl" -}}http://{{ include "am.core" . }}:8420{{- end -}}

{{/* Non-root, read-only root fs; write paths are PVCs or emptyDirs. */}}
{{- define "am.podSecurity" -}}
runAsNonRoot: true
runAsUser: {{ .Values.securityContext.uid }}
runAsGroup: {{ .Values.securityContext.uid }}
fsGroup: {{ .Values.securityContext.uid }}
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "am.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- end -}}
