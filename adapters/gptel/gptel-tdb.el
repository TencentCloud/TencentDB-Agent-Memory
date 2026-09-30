;;; gptel-tdb.el --- gptel backend for the TencentDB Agent Memory proxy -*- lexical-binding: t; -*-
;; Ready-to-load backend registration.  Key comes from the TDB_MEM_USER_KEY
;; environment variable (sk-mem-... business user key) -- adjust if you keep
;; it in auth-source instead.  The model symbol must equal the proxy's
;; PROXY_UPSTREAM_MODEL.
;;; Code:
(require 'gptel)

(setq gptel-model 'claude-sonnet-4-20250514
      gptel-backend (gptel-make-openai "TencentDB Agent Memory"
                      :protocol "http"
                      :host "127.0.0.1:8096"
                      :endpoint "/codebuddy/default/chat/completions"
                      :stream t
                      :key (lambda () (getenv "TDB_MEM_USER_KEY"))
                      :models '(claude-sonnet-4-20250514)))

(provide 'gptel-tdb)
;;; gptel-tdb.el ends here
