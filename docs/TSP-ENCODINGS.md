# TSP encodings, verified against Tern 0.5.0

Tern answers a program's frames with `{"ev":"error","sf":…,"s":<frame>,"op":<index>,"msg":…}`
for anything it does not accept, which makes the protocol **empirically testable rather
than guessable**. Everything below was established by sending one candidate per frame and
reading Tern's reply — not from documentation, and not by inference.

Reproduce it with [`scripts/tsp-probe.mjs`](../scripts/tsp-probe.mjs):

```bash
tern new tab --keep-open -- sh -lc \
  'node scripts/tsp-probe.mjs /tmp/probe.log /path/to/any.png; sleep 20'
tern capture <block> | grep -o '{"ev":"error"[^}]*}'
```

> Read the errors from **`tern capture`**, not from the probe's stdin: a program started
> through `sh -lc` does not own the pane's pty, so Tern's replies land in the pane's output
> instead of reaching the process. `pi-tern`'s native mode *does* own the pty, which is why
> it can read them directly.

## What Tern 0.5.0 advertises (from its own hello reply)

```
kinds    col row card section rule spacer text md code diff ansi math image kv table tree
         badge kbd icon spinner shimmer elapsed progress rate list item tabs editor input
         status seg overlay toast rows picker prefs tool checklist agent chart meter block
         effort el                                                     (44 kinds)
features blobs settle adopt dock program-palette reduce-motion aside scroll styles flow
apc      65536
credits  2
```

## Frame shapes: accepted vs rejected

| Frame / node | Verdict |
| --- | --- |
| `["add","main",<surface>,null,{id:"main",k:"col",c:[]}]` | **accepted** — region roots go *under the surface id* |
| `["add",id,"main",null,{id,k:"rows",p:{cols,lines}}]` | **accepted** |
| `["add",id,"main",null,{id,k:"md",p:{text}}]` | **accepted** |
| `["add",id,"main",null,{id,k:"image",p:{data,mime}}]` | **accepted** |
| `["add",id,"main",null,{id,k:"image",p:{blob:{mime,data}}}]` | **accepted** |
| `["add",id,"main",null,{id,k:"chart",p:{…}}]` | **accepted** |
| `["add",id,"main",null,{id,k:"card",c:[…]}]` | **accepted** |
| `["add","aside",<surface>,null,{id:"aside",k:"col",c:[…]}]` | **accepted** — the right-edge sheet |
| `["set",id,{…}]` | **accepted** |
| `["blob",id,mime,data]` | **REJECTED** — `unknown op blob` |
| `["blob",mime,data]` | **REJECTED** — `unknown op blob` |

**The blob store is not a frame op.** `function blob(self, bytes: string, mime: string): string`
is a *plugin/canvas* API — `self` is the canvas handle — so the one caller that can use it is a
Luau plugin. A program writing frames must inline the bytes in the node, which is why
`pi-tern`'s `figure()` sends `{k:"image", p:{data, mime}}`.

## Two consequences worth stating plainly

1. **`file://` links always open in Tern** (its own documentation says so, for a file block).
   A `rows` node is inert text and can never be clicked, so **anything the reader should be
   able to open has to arrive as an `md` node**. That is the entire mechanism behind
   clickable file references — no new API, no plugin.
2. **`aside` is a sheet docked at the pane's right edge with a draggable width** — the build's
   own CSS calls it `--tv-aside`. An `md` node inside it is the "small preview panel with a
   scrollbar", and a markdown link to `file://…` is the "open in split" button.

## What this does not yet prove

Frame acceptance is not the same as pixels: an accepted node can still render nothing if its
props are wrong (`chart` in particular — only `{kind:"bars", bars:[…]}` was tried, and Tern
does not error on unknown props). Closing that gap needs a screenshot, and the two routes to
one are both unavailable from a T3-hosted agent:

- `screencapture` needs Screen Recording permission (not granted on this machine).
- `tern shot` + `surface-play` replays a recording but **does not host a surface**: a scenario
  baseline measured 370 elements, and the same scenario with `surface-play` measured **371** —
  one element, i.e. nothing rendered. TSP is only parsed in a pane that owns its pty.
