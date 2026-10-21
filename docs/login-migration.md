## Local logins after removing 1Password

QuatiBot no longer connects to 1Password. Save logins locally in Settings →
Logins to let bots fill them. Bot permissions, site restrictions, passwords and
2FA keys in the local vault are preserved.

On startup, QuatiBot removes the old service account token and vault permissions
from its encrypted local vault after decrypting and validating the local logins.
An unreadable vault is left unchanged; restore its original key before retrying.
Old external login references are unavailable, not converted to local logins.

Deleting the local token **does not revoke it in 1Password**. Revoke the service
account token in 1Password itself. QuatiBot does not attempt remote revocation.
