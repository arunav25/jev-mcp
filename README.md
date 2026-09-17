# JEV MCP · Structured Judgments & LLM Evaluation

Connect JEV to MCP clients and compare its judgments against general-purpose LLMs using shared
datasets and measurable accuracy.

Agents are good at producing text and bad at producing answers you can branch on. Ask one "is this
ticket urgent?" and you get back a sentence you then have to parse, with no number attached — no way
to tell a confident yes from a coin flip. This server exposes TypeSafe's Jev classifier as a single
MCP tool that returns typed answers with probabilities, so the agent gets `0.94` and moves on.

```
  agent  ──── evaluate ────▶  jev-mcp  ──── POST /v1/systemone ────▶  TypeSafe
 (stdio)                     (this)                                    (Jev)
         ◀─── typed JSON ───           ◀─── probabilities ────────

  jev-eval ── same question ─▶ JEV  ─┐
                             ─▶ LLM ─┴─▶ Brier · calibration · McNemar
```

Two halves: an MCP server that exposes the classifier to your agents, and an evaluation harness that
tells you whether it is actually beating whatever you were using before.

## Requirements

- Node.js 20 or newer
- A TypeSafe API key from [console.typesafe.ai](https://console.typesafe.ai/)

## Install

```sh
npm install -g jev-mcp
```

Then point your agents at it. The key has to be in your environment *before* you run this, because
agents launch the server without your shell, so its value is written into each client's config:

```sh
export TYPESAFE_API_KEY=sk-...
jev-mcp install
```

That registers the server with Claude Code, Claude Desktop and Codex, skipping any that aren't
installed. Restart Claude Desktop afterwards. To see what it would do first:

```sh
jev-mcp install --dry-run
jev-mcp install --client codex   # or limit it to one
```

<details>
<summary>Registering by hand</summary>

Any MCP client that speaks stdio will do. Run `jev-mcp doctor` to get the exact launch command, then:

```json
{
  "mcpServers": {
    "jev": {
      "command": "/usr/local/bin/node",
      "args": ["/usr/local/lib/node_modules/jev-mcp/src/cli.js", "serve"],
      "env": { "TYPESAFE_API_KEY": "sk-..." }
    }
  }
}
```

</details>

## Using it

One tool, `evaluate`. Give it the material to judge and one or more questions:

```json
{
  "state": {
    "subject": "Payouts failing",
    "body": "Help! My payouts have been failing for 3 days."
  },
  "questions": {
    "is_urgent": {
      "type": "noul",
      "instructions": "Does the sender need a response today rather than this week?"
    },
    "department": {
      "type": "choice",
      "instructions": "Which team should own this ticket?",
      "criteria": {
        "billing": "Payments, payouts, refunds, invoices",
        "technical": "Bugs, outages, API errors",
        "sales": "Pricing and plan changes",
        "unclear": "Not enough information to route"
      }
    }
  }
}
```

Back comes the answer under the same keys you used:

```json
{
  "model": "jev-latest",
  "answers": {
    "is_urgent": { "type": "noul", "noul": 0.94 },
    "department": {
      "type": "choice",
      "choice": "billing",
      "probabilities": { "billing": 0.88, "technical": 0.09, "sales": 0.02, "unclear": 0.01 },
      "confidence": 0.81
    }
  }
}
```

### Question types

| Type | Criteria | Returns |
| --- | --- | --- |
| `noul` | optional `{"true": …, "false": …}` | `noul` — probability the condition holds |
| `choice` | required map of option → description or `null` | `choice`, `probabilities`, `confidence` |
| `score` | required ordered array of 2+ level descriptions | `score`, `legend`, `probabilities`, `confidence` |

### Getting good answers

- **`state` is the only thing a question can see.** Put every fact the decision rests on there.
- **Question keys aren't sent to the model.** Calling one `urgent` explains nothing — the
  instructions have to define what urgent means here.
- **One judgment per question.** Two decisions in one set of instructions blur the distribution.
- **Questions in a call can't see each other's answers.** They run together over the same state. If
  step two depends on step one, make two calls.
- **Give `choice` an escape hatch** when the input might match nothing.
- **`score` levels have to describe real situations.** A bare 1–5 scale gives the model nothing to
  anchor on.
- **0.5 on a `noul` means uncertain**, not "medium amount of the thing you asked about". And
  `confidence` measures how concentrated the distribution is, not whether the answer is right.

Malformed questions are caught here, before the request goes out — a `choice` with no criteria or a
`score` with one level comes back as a message the agent can fix, not a 422 and a wasted round trip.

## Measuring whether it's actually better

`jev-eval` is a harness for answering "which one is more accurate?" with a number that survives
scrutiny. It exists because the usual version of that comparison — run ten inputs through both, eyeball
the outputs — cannot detect anything. Here is the arithmetic:

| Effect to detect | Disagreement rate | Labelled items needed |
| --- | --- | --- |
| 90% → 92% (2 points) | 15% | **2,941** |
| 90% → 92% (2 points) | 25% | **4,904** |
| 85% → 90% (5 points) | 20% | 626 |
| 80% → 90% (10 points) | 25% | 194 |
| 70% → 85% (15 points) | 30% | 103 |

80% power, α = 0.05, paired McNemar. Run `jev-eval power --from 0.9 --to 0.92` for your own numbers.

A two-point gap over ten calls is three orders of magnitude short of conclusive. Any ranking drawn
from it is a coin flip wearing a number.

### The loop

```sh
jev-eval init datasets/urgency --question "Does this message need a response today rather than this week?"
# put your real items in datasets/urgency/items.jsonl, one JSON object per line:
#   {"id": "t-001", "state": {"subject": "...", "body": "..."}}

jev-eval label datasets/urgency --rater rater-1     # never shows you a model's answer
jev-eval label datasets/urgency --rater rater-2     # a second rater bounds what's resolvable
jev-eval agreement datasets/urgency                 # Cohen's kappa between the two

jev-eval run datasets/urgency --system jev --run jev
jev-eval run datasets/urgency --system openai:model=gpt-4o-mini,mode=logprobs --run llm

jev-eval compare datasets/urgency -a jev -b llm
```

Both systems are asked the identical question — it lives in the dataset's `config.json`, not in the
command — and `compare` scores them only on items both covered, so the per-item difficulty cancels.

### What it reports

- **Brier score** and **log loss** — proper scoring rules, computed on the probability itself rather
  than on which side of 0.5 it fell. This is the headline, not accuracy.
- **Calibration (ECE + reliability table)** — of the things it called 0.9, how many happened? A model
  that is 85% accurate and honest about it beats one that is 87% accurate and says 0.99 every time.
- **AUC** — ranking quality, independent of any threshold.
- **Accuracy, precision, recall, F1** at 0.5 and at the best available threshold.
- **95% bootstrap intervals** on every one, seeded so a rerun reproduces exactly.
- **McNemar's test** on the paired decisions — exact binomial below 25 discordant pairs, where the
  chi-square approximation misleads.

When an interval spans zero, the report says so in those words and tells you how many more items
you would need. "No difference detected" is a result; "System A won" from a 10-item sample is not.

### Getting a probability out of a general LLM

The baseline adapter has two modes, and the choice matters more than the model does:

- `mode=logprobs` constrains the reply to one token and reads the distribution over `Yes`/`No`. This
  is the fair comparison — a real probability, not a stated one.
- `mode=verbalized` asks the model to say a number. Convenient, and reliably badly calibrated: models
  pile up on 0.8/0.9/0.95. Use it to reproduce what a hand-rolled comparison actually measures, and
  read its ECE knowing part of the gap is the interface, not the model.

The Anthropic adapter is verbalized-only, since the Messages API exposes no logprobs.

### Before trusting any of it

Run `jev-eval agreement` first. If two people labelling the same items score κ below about 0.6, the
question is ambiguous and no amount of data will separate the systems — the ceiling on what an eval
can resolve is how consistently humans can answer it. Fix the question, then collect labels.

## Commands

| Command | What it does |
| --- | --- |
| `jev-mcp serve` | Run the MCP server over stdio. This is what agents invoke. |
| `jev-mcp install` | Register with Claude Code, Claude Desktop and Codex. |
| `jev-mcp doctor` | Show the resolved key status, endpoint, launch command and config path. |
| `jev-eval …` | Evaluation harness — see above. `jev-eval --help` lists its subcommands. |

## Environment

| Variable | Purpose |
| --- | --- |
| `TYPESAFE_API_KEY` | Required. |
| `TYPESAFE_BASE_URL` | Override the API host. Useful for staging and tests. |
| `OPENAI_API_KEY` | Only for the eval harness' baseline adapter. |
| `ANTHROPIC_API_KEY` | Only for the eval harness' baseline adapter. |

Every `TYPESAFE_*` variable in your shell is carried into the client configs by `install`.

## Behaviour worth knowing

- `429`, `529` and transport failures are retried four times with jittered exponential backoff, and
  a `Retry-After` header is always honoured over the computed delay. `401` and `422` fail straight
  away — retrying a bad key or a bad request only wastes time.
- Response bodies are capped at 8 MB.
- `stdout` carries the MCP protocol and nothing else; all diagnostics go to `stderr`.
- The Claude Desktop config is written via a temp file and a rename, so a failed write can't truncate
  a file that also holds your own preferences. Every other key in it is preserved.

## Development

```sh
npm install
npm test          # node:test, no test runner dependency
node src/cli.js doctor
node bin/eval.js --help
```

## License

MIT — see [LICENSE](LICENSE).
