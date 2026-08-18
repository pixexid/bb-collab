# Graded placement probe: `visibleMarkdown`

This is the frozen task for model placement probes. It lives here rather than in a
lane brief because briefs archive with their threads, and a probe that cannot find
the previous task cannot be compared to the previous result.

## Why this task

A placement probe is only worth running if it can distinguish a strong result from
a weak one. An earlier probe asked for `isStrictlyIncreasing` against four fixed
assertions; every model in the matrix passes it, so the grade carried no
information. This task has edge cases a competent model can plausibly get wrong —
fence length, fence character, close-line strictness, ordering between two removal
passes — which is what makes a pass mean something.

The repository contains a reference implementation, so the task is known-answer.
That reference is off-limits to the subject and is the grader's key.

## The specification, frozen

Implement, from this specification alone:

```ts
export function visibleMarkdown(text: string): string
```

It returns the input with these removed:

- every HTML comment `<!-- ... -->`, including one that is never closed — everything
  from the opener to end of input goes;
- every fenced code block, including its opening and closing fence lines.

Everything else is preserved. Surviving lines are rejoined with `\n`.

Line splitting accepts both `\n` and `\r\n`. A carriage return is removed only as
part of a CRLF pair — consumed by the split itself. A lone carriage return, including
one at the end of the input, is ordinary text and survives in its line. Output always
uses `\n`.

That distinction is load-bearing and was got wrong once: an earlier wording said "a
trailing carriage return is not part of a surviving line", which two subjects
implemented identically and which the reference does not do. See the note at the end
of this file.

Fence rules:

- a fence opens on a line whose first non-whitespace run is three or more backticks,
  or three or more tildes;
- the fence character and its length are captured at the opener;
- the block closes on a line that is only whitespace plus the same character
  repeated at least as many times as the opener;
- a backtick fence is not closed by tildes, or the reverse;
- a shorter run than the opener does not close the block;
- a fence that is never closed swallows the rest of the input.

HTML comments are stripped before fence processing.

## Running it

The subject implements from the specification above and nothing else, writes its own
test cases before checking itself against anything, and works in scratch space —
no commit, no branch, no PR, no canonical or plugin state.

`scripts/pr-lifecycle.mjs` holds the reference and is off-limits to the subject. A
subject that opens it by accident discloses that; a concealed read invalidates the
probe.

The subject does not grade itself. An independent grader on a different model diffs
the sample against the reference and against this specification, and reports
divergence from each separately — a sample can follow the specification exactly and
still differ from the reference where the specification is silent, and that is a
specification defect rather than a subject defect.

The subject also reports its requested versus executed execution profile without
inferring execution from request flags. Fields that cannot be read from a real
surface are reported as unknown; see the executed-profile gap tracked in the issue
queue.

## Correction, 2026-08-18: the reference is authoritative

The CRLF paragraph above previously read "a trailing carriage return is not part of a
surviving line". Both GH-222 subjects implemented that sentence — stripping a lone
line-final `\r` — and each wrote an explicit test for it before checking anything. The
reference in `scripts/pr-lifecycle.mjs` keeps that carriage return. A differential
harness over 20,000 fuzz inputs found exactly one divergence class between reference
and subjects, and every instance of it was this.

Two subjects implementing a sentence identically, against the reference, is not
ambiguity. It is a second authority: the spec had begun to specify something the
system never intended, and every future probe would have graded against a fork.

Ruled: the reference is authoritative and the sentence was defective. The clause was
collateral from adding the CRLF rule and was never a deliberate requirement. Corrected
above rather than reinterpreted, so no probe inherits the fork.

A grader keying strictly on the reference would have failed both subjects for obeying
the specification. That is the cost of leaving the two out of step, and the reason this
correction carries its provenance rather than arriving as a quiet edit.
