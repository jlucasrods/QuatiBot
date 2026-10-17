# Bots, teams and memory

A bot has a profile, selected OpenCode model, instructions, working directory and available tools. Tasks provide separate conversation threads. A room contains a roster of bots and a lead; direct mentions select recipients, while automatic routing can use the optional decision model.

Bots can delegate work and questions through the coordination tools. The backend tracks active work, pending approvals and completed results so the originating conversation can present an answer.

Conversation history and bot memory are different kinds of state. History records messages and execution activity. Memory stores reusable context for future work. Keep durable preferences and useful facts in memory rather than relying on a single long conversation to remain in the model's context.

Workspace state persists in the configured data directory. Attachments and generated files belong to their bot or thread context. Review sensitive memory before exporting or sharing workspace content.

See [architecture](architecture.md), [routines](routine-schedules.md) and [the decision model](decision-model.md).
