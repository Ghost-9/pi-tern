# Security

## Reporting a vulnerability

Use GitHub's private advisory form:
<https://github.com/Ghost-9/pi-tern/security/advisories/new>

Please include the extension version, pi version, Tern version, and a minimal reproduction.
Do not open a public issue for a vulnerability before it is fixed.

## Scope

`pi-tern` is a pi extension. Extensions run inside the pi process with the same operating-system
permissions as pi itself, so a malicious extension can read pi's context, files and credentials.
That is a property of pi's extension model, not of this extension. Review the source before
installing and install only from sources you trust.

What this extension does with access:

- writes the TSP `hello` probe to the pty and consumes TSP/DA1 replies from raw input;
- optionally writes a session mirror to `~/.pi/agent/scratch/pi-tern/`;
- shells out to the `tern` CLI (`open`, `capture`, `ls`, `ctl`, `browser`) and speaks to Tern's
  local daemon socket (`$TERN_PANE_SOCKET`);
- keeps browser screenshots under `~/.pi/agent/scratch/pi-tern/`.

It does not open network connections, does not read credentials, and does not write outside
`~/.pi/agent/scratch/pi-tern/` and the conversation path.
