# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately to balegabme@gmail.com.
Do not open public issues for security problems.

## What the permission system does and does not do

NanoHarness scopes a session's file tools to the folder it was started in.
Anything outside that folder stops the turn and asks. The shell is the
exception by design: a command line is a program, and no parser can say what it
will touch, so the command is shown whole and approved whole.

**Auto-approve mode is a check, not a sandbox.** When it is on, a second model
reads each action the folder rule cannot settle and answers allow or deny. It
decides, because the mode exists for runs nobody is watching. Where it is
unsure it denies. An approved command still runs with everything the user's own
account can reach: there is no filesystem or network containment yet, so the
model's judgement is the only thing between an approved command and the machine.
Turning the mode on means accepting that.

The text being judged can come from a file the agent read, an MCP server's
answer or a fetched page, so it is attacker-influenceable. The approval prompt
is given the action as fenced data and is never given tool results, which is
where such text would arrive. That is a mitigation and not a guarantee: treat
auto-approve as a way to cut the number of prompts you answer carelessly, not
as a boundary that can hold against a determined attacker.

`docs/harness/approval.md` describes the design in full.
