# Environment detection

What the machine is and what it has installed, found out once per launch and
written into every system prompt. A model that is not told reasons from its
training set, decides it is on Linux with Python 3 and ripgrep, and spends
rounds finding out otherwise. Plan §12.

Files:
- src/env/shell.ts: which bash every command runs through, and the PATH it starts with
- src/env/probe.ts: the machine probe, and the lines the system prompt carries

## The shell

Everything the harness runs goes through one bash: the `bash` tool, the hooks
and the probe below. `shell.ts` decides which bash that is and what PATH it
has, so the three agree about the machine.

On macOS and Linux it is `bash` from the PATH. On Windows it is Git Bash, looked
up under Program Files. A Windows machine without Git for Windows has no shell:
the `bash` tool refuses with a line saying so, a hook becomes a note, and the
prompt tells the model the shell is missing. Plan §6 names PowerShell as the
fallback; it is not built.

## The login PATH

A shell started from a GUI app does not have the PATH a terminal has. What a
login profile adds is `~/.local/bin`, `~/.cargo/bin`, and on macOS the PATH a
GUI-launched app has no other way to inherit. It does not add `grep`, `sed` and
`curl`: Git Bash prepends `/mingw64/bin` and `/usr/bin` either way.

Sourcing the profile costs three to four seconds on Windows, and a command that
started a login shell every time paid it every time. A profile does not change
while the app is open, so it is read once per process: `bash -lc` prints its
PATH, and every command after that starts without `-l` and with that PATH set.
On Windows the value is converted back with `cygpath -w -p`, which round-trips
a real PATH without losing a segment. Measured end to end, a command went from
about 3.5s to about 0.45s.

No command waits on the read. The app starts it while the window is being built,
and a session cannot issue a tool call before a model has answered, by which
time the read has long finished. A command that arrives first starts its own
login shell, and so does every command if the read fails or never returns.

`warmShell()` settles when the read has finished. The probe below waits on it,
and so does a test file that runs many commands, because each test file is a
process of its own.

## The probe

One bash script, run once per launch through the shell above once the PATH
read has finished. The probe sees the PATH the agent's commands will see, and
does not source the profile a second time beside the read. It prints a key and
a value per line:

- the bash version,
- whether `sed` is GNU or BSD, which decides whether `sed -i ''` or `sed -i`
  is right,
- and `--version` for each tool it looks for: git, node, bun, python, pnpm,
  npm, yarn, rg and fd.

A tool is looked for under every command it is installed as. Debian installs fd
as `fdfind`, and a Windows machine often has `python` and no `python3`. The
first command that answers with a version is reported, since that is the one
the agent should type. A `--version` that prints no version counts as not
found, which is how the Windows store stub that answers to `python3` is caught.

The operating system comes from Node, with the distribution read from
`/etc/os-release` on Linux, since the kernel release alone does not say whether
to reach for `apt` or `dnf`.

The probe has 20 seconds, enough for every `--version` on a cold Windows
machine. The script's last line says it finished. A probe that runs out
reports the tools it had found by then and calls none of the others missing,
since it never asked about them. Its answer is not kept, so the next session to
start probes again.

## What the prompt carries

A few lines, in a fixed order:

```
OS: Windows 10.0.26200, x64
Shell: bash 5.2.37 (Git Bash) with the login PATH, running one script per command, with GNU coreutils
Tools: git 2.47.1, node 22.11.0, python 3.12.4, pnpm 11.12.0
Not installed: bun, npm, yarn, rg, fd
```

The missing tools are listed as well as the found ones. A model told nothing
about ripgrep will try `rg` and read the error; one told it is not installed
reaches for the `grep` tool first.

The lines sit in the system prompt, inside the cached prefix, so they hold
nothing that moves while the app runs: no clock, no load, no free disk. The
probe runs once per launch and every session of that launch gets the same
answer. A tool installed while the app is open shows up at the next launch.

The app starts the probe at launch, behind the PATH read. The first session's
prompt waits for it, and by the time a person has typed a message it has
usually finished.
