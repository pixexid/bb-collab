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

Line splitting accepts both `\n` and `\r\n`, and a trailing carriage return is not
part of a surviving line. Output always uses `\n`.

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
