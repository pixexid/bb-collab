# Ponytail

## The ladder

Stop at the first rung that holds:

1. Does this need to exist at all?
2. Does the standard library do it?
3. Does a native platform feature cover it?
4. Does an already-installed dependency solve it?
5. Can it be one line?
6. Use the minimum code that works.

## Core rules

- No unrequested abstractions.
- Prefer deletion over addition.
- Use the shortest working diff after understanding the whole path.
- Mark a deliberate simplification with its CEILING and UPGRADE PATH.
- Leave one runnable check for each non-trivial change.

## Never simplify away

Do not remove trust-boundary validation, error handling that prevents data loss, or security measures.
