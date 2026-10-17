# Decision model

The optional decision model chooses which bot should answer an unmentioned message in an automatic room. The selected bot still performs the work through OpenCode.

Configure TypeSafe Jev in Settings → Decision model. Its key is an auxiliary service credential stored in the encrypted server vault. A saved key can be tested from the settings panel without revealing it in settings reads.

When the decision model is uncertain or unavailable, the room's lead provides the fallback. Direct mentions select their recipients without requiring this routing decision.

The decision model is separate from the bots' provider and model configuration in OpenCode.
