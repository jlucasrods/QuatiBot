# Storage and access

## Workspace

The workspace defaults to `~/.quatibot`; `QUATI_DATA_DIR` selects another directory. It contains bot configuration, conversations, files, memory, routines, attachments and local execution records. Protect the directory and its backups as private application data.

Local diagnostic logs and token/cost history support troubleshooting and usage inspection. Product analytics are not collected or sent.

## Credentials

OpenCode owns model-provider credentials. QuatiBot reads native model and extension metadata without exposing provider secrets to the frontend.

Auxiliary service keys saved in QuatiBot settings are encrypted in `credentials.enc` with a separate `credentials-key` file. Both files use owner-only permissions. The key and ciphertext must be kept together on trusted storage; an attacker with both can decrypt them.

Website passwords and login material use the backend login vault and its key. A login's site restrictions and bot grants determine who can use it. Authentication material is not returned in ordinary settings reads or inserted into conversation text.

Unreadable vaults fail closed. Restore the correct key and ciphertext before saving changes. An undecryptable vault is not treated as an empty one. Portable workspace exports exclude credential vaults and their keys; arrange trusted secret backups separately.

## Browser sessions

Remote access requires a paired session. Device pairing uses an expiring, single-use code. Admin sessions can change settings and pair devices; client sessions are restricted to chat and approvals. Session revocation removes that device's access.

Keep the backend port private behind an HTTPS proxy or private network. Forward WebSockets for live updates and viewers. Do not grant loopback-owner trust to requests merely because they arrived through a local proxy.

## Tools and computers

Tool authority is scoped to the originating turn. Internal MCP bearers are not general administrative credentials. Browser and VM actions follow bot settings and approvals. Desktop control is confined to the isolated VM; the operator's mouse, keyboard and screen are not capture targets.
