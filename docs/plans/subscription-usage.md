# Plan — subscription usage

A subscription is an allowance, and the question it answers is how much of the
allowance is gone. `cost.md` answers a different one. The usage log counts money
at the prices a model carried while it ran; a plan counts consumption against
caps the vendor sets, resets on its own clock, and reports as a percentage. The
two figures move together and never meet, so this is a module of its own rather
than another column on the spend view.

Status: not built. When it is, this page becomes `docs/harness/subscription.md`
with a `Files:` section and a line in the doc map. It lives here until then
because `nh doc-check` reads `docs/harness` and would fail a page listing files
that do not exist.

## Why the harness does not work the figure out itself

One version of this shipped briefly and came back out. A model fact called
`planMultiplier` held the ratio between a model's price and what it spent of an
allowance, transcribed from a vendor's docs, and the window multiplied the
session's local spend by it and drew the answer as a second pill.

Every input to that was the harness's own: token counts it had added up and
prices somebody had typed into a table, against a ratio read off a web page on
one particular day. None of it came from the account being measured, and the
unit was wrong on top of that, since an allowance is a share of a window rather
than a number of dollars. It read as a balance and was arithmetic.

So the reading comes from the provider or it does not appear. Each vendor
answers at its own address, in its own shape, over whichever method it wants,
and names its own windows; what this module owns is one normalised shape to draw
and one adapter per vendor to reach it. Nothing about a plan is computed from
prices here, and a vendor the harness cannot reach leaves the meter absent
rather than estimated.

## Why it is separate from the provider layer

`providers.md` opens with a rule: a provider is a wire format, not a vendor, and
no vendor address is compiled in anywhere. A plan meter cannot honour that. A
subscription is an account at a named company, read from an address only that
company answers, in a shape only that company returns, and there is no generic
version of it.

So the rule is kept by keeping the meter out of the provider layer. Vendor
addresses live in `src/subscription/<vendor>.ts` and nowhere else, one file
each, and the provider layer stays what it says it is. Someone running
`anthropic` against a local gateway still meets no vendor name; someone adding a
plan has named one on purpose.

The scopes differ too. Spend is per turn, per session, per folder, and belongs
to the log. A plan window is account-wide: the same counter moves when the same
key is used from another machine, another harness, or the vendor's own CLI.
Filing that under a session would misdescribe what was measured.

## What each vendor actually answers

Both were read from live accounts. The findings are the design constraints, so
they are written down rather than assumed.

**opencode (Go plan)** — `GET https://opencode.ai/zen/go/v1/usage`, bearer key,
and a browser `User-Agent` because the host refuses anything else. One route;
`whoami`, `billing` and any summary are 404.

```json
{"usage":{"rolling":{"status":"ok","percent":0,"resetsAt":"…"},
          "weekly":{…},"monthly":{…}}}
```

Three windows, `percent` an integer the server floors, `status` either `ok` or
`rate-limited`. No cap, no money, no request count. A tick of one percent is
worth whatever the plan's window is, and the plan's window is not in the answer,
so there is no way to turn a tick into money from this route alone.

Two behaviours shape the code more than the fields do. `resetsAt` is the bucket
anchor: it freezes at the first request of a window and stays put until that
window expires, and while `percent` is 0 it holds a placeholder of now plus the
window length, which slides forward on every poll. And the rolling window is a
five-hour bucket opened by first use, fixed until it lapses.

**Command Code (GOAT plan)** — four routes on `https://api.commandcode.ai`,
bearer key, plus `x-command-code-version` and `x-cli-environment` headers that
the vendor's own client sends.

| Route | What it is for |
| --- | --- |
| `/alpha/whoami?limits=1` | the account, and the org id that scopes the rest |
| `/alpha/billing/credits` | remaining credit, and both windows as `used`/`cap` in USD |
| `/alpha/billing/subscriptions` | plan id, status, billing period |
| `/alpha/usage/summary` | spend, requests and tokens for the period |

Absolute dollars at nine decimals against a stated cap, which is everything the
opencode answer is missing. `since` takes an ISO-8601 datetime but truncates to
the day, so it cannot isolate a session; `until` is accepted and ignored. There
is no per-request route.

One thing about those routes sets the schema: an account has two gates, and they
move independently. The windows report consumption; the credit buckets and the
subscription status decide whether a request is served at all, and one refused
for credit comes back `400 insufficient credits` whatever the windows read. A
meter drawing only window percentages can show a healthy plan on an account the
vendor will turn down.

## The shape everything normalises to

Adapters differ; the view draws one thing. `src/core/subscription.ts` holds the
shape and the arithmetic, for the reason `buildReport` lives in core: a figure
on screen and a figure anywhere else must not be able to disagree.

```
PlanSnapshot
  vendor       which adapter answered
  planName     what the vendor calls the tier, where it says
  state        ok | blocked | auth-failed | unreachable | unknown-shape
  windows      PlanWindow[]
  balance      money left, where the vendor reports money
  readAt       when this reading was taken
  stale        age of the last good reading, when the current fetch failed

PlanWindow
  id           five-hour | weekly | monthly, or whatever the vendor names
  label        the vendor's own word for it
  percentUsed  0–100
  precision    exact | integer
  used, cap    money, only where the vendor gives both
  resetsAt     epoch ms, or null
  exceeded     the vendor said this window is spent
```

Five decisions are carried in that shape.

Percent is the only field every vendor can fill, so the view has to be drawable
from percent alone, and the absolutes are a bonus the Command Code adapter
happens to provide. Writing it the other way round leaves opencode with a row of
blanks.

`precision` exists because the resolution differs. opencode floors to whole
percent, so its numbers move in steps worth roughly a tenth of a window each.
Rendering `37%` identically for both vendors would promise a precision one of
them does not have, and the view marks the integer kind instead.

`resetsAt` is nullable and the adapter nulls it. opencode's placeholder is a
real timestamp that means nothing, and a countdown drawn from it never reaches
zero. Filtering that at the edge keeps one vendor's quirk out of the view.

`state` is not derived from the windows. Command Code gates on credit and on
windows separately, so a snapshot inferring health from percentages could call a
plan fine while the vendor turns down its next request.

Windows come back as a list. opencode reports five-hour, weekly and monthly;
Command Code reports five-hour and weekly with credit as a balance instead;
whatever lands next will differ again. Three named fields force empty slots and
quietly invite the view to draw them.

## The adapters

One file per vendor under `src/subscription/`, and `factory.ts` beside them as
the single place a vendor id becomes a client, the way `providers/factory.ts`
does for wire formats.

An adapter fetches, parses, and returns a `PlanSnapshot` or throws. It does not
retry, cache or schedule — that belongs to the poller, and an adapter retrying
privately would be a second policy nobody could see.

`opencode.ts` fills three windows with `precision: 'integer'`, no `used`, no
`cap`, no balance, and nulls a reset whose percent is 0. `commandcode.ts` fills
two windows with `precision: 'exact'` and real money, takes `planName` from the
subscription route, sets `balance` from the credit buckets, and sets
`state: 'blocked'` when those buckets are empty or the subscription is not
active, which is the only way the view learns what the windows cannot say.

A response the adapter does not recognise raises `unknown-shape` and names the
field that failed. Both APIs are undocumented and unversioned, and a silent zero
would read as a plan nobody has touched.

## Reading it

One poller in the main process, cached, broadcast to every window over IPC.
Sessions do not poll. Three open sessions hitting a private endpoint is how a
rate limit gets discovered in production.

A fixed timer is the wrong instrument. opencode only moves in whole percent, so
most of a minute-by-minute schedule returns the byte already held, and the
endpoint sits behind key- and IP-level limiters whose thresholds are unknown.
The poller runs on events instead:

- once when a session opens, for the baseline and the reset times,
- after a turn finishes, debounced to a floor of one fetch a minute,
- when a window's `resetsAt` passes,
- and on a slow idle heartbeat, ten to fifteen minutes, only while the meter is
  on screen, which is the only way usage from another machine ever arrives.

For a percent-only vendor there is one refinement worth the code. The harness
already knows what it estimates it has spent since the last successful fetch, so
it also knows whether a tick is arithmetically possible yet. Below roughly half
a percent of a window a fetch cannot return anything new, and is skipped. Every
request that survives that test carries information.

Those ticks are worth keeping. Each one relates the harness's own estimate to
real window consumption, and a running fit over several of them recovers the
dollars-per-percent that opencode will not state, which is the only honest route
to "this turn was about a third of a percent". Until enough ticks exist the view
shows the local figure and the vendor's percentage side by side and draws no
line between them.

Failures follow the rule the rest of the harness follows. A 401 or 403 is
permanent: the meter stops, says the credential was refused, and does not retry
on a timer. A 429, a 5xx or a dead socket keeps the last good reading with its
age shown, and backs off. Nothing renders as zero because a fetch failed.

## Credentials and settings

A plan record is `{id, vendor, label, baseURL}` in `StoredConfig`, beside the
provider list and safe to commit for the same reason: it names no secret. The
key goes to the OS store through `secret-store.ts`, on the path provider keys
already take, and `baseURL` defaults to the vendor's address and stays editable
for anyone pointed at a staging host.

Plans are their own list in settings, not a field on a provider. One account
often serves several providers, and a plan with no provider attached is an
ordinary thing to want to watch.

## The view

The meter belongs in the sidebar foot, beside **Spend**, because it is an
account fact rather than a session fact and the topbar is for the session. One
row: the binding window, meaning the one closest to its cap, as a thin bar with
its percentage and its name. Clicking it opens a panel listing every window with
its bar, `used` of `cap` where the vendor gives them, and a countdown where the
reset is real, with the balance and the plan name above. A blocked plan says so
at the top, in the error colour, whatever the bars read.

The Spend view gains a line tying the two together and keeps them apart: the
money for the window on one side, the plan's consumption on the other, never
added. Percentages of a subscription and dollars of API spend do not share a
total, and a view that summed them would invent one.

## Scope

This pass builds the module, the two adapters, the poller, and the view.

z.ai is next and nothing here needs changing for it: another file under
`src/subscription/`, another entry in the factory, whatever windows it reports.
That was the point of the list.

A `nh` twin comes free later, since the arithmetic is in core and the terminal
already has `nh usage` to sit beside.

## Settle these first

Two questions the live probes could not close, both cheap to answer with a key
and a short script, and both able to change the schedule above.

What opencode's rate limit on that endpoint actually is. Worth finding on
purpose rather than in front of a user.

How long Command Code takes to count a finished request. Per-turn diffing there
rests on the counters being current by the time the turn ends, so the lag is
worth timing over a few turns before the view promises a per-turn figure.
