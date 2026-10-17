---
name: verify-quati
description: "Verify QuatiBot server and conversation changes against an isolated fake-engine instance before claiming they work."
---

# Verify QuatiBot

Follow the canonical instructions in `docs/verification/README.md`. Use its
shared control tool; do not improvise raw API calls or drive the user's live
QuatiBot instance. Distinguish fake ACP orchestration checks from real
model inference, browser execution and VM execution.
