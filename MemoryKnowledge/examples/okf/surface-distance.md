---
type: Attested Computation
title: Surface distance computation
runtime: python
status: draft
parameters:
  - {name: candidate, type: path, required: true}
  - {name: reference, type: path, required: true}
executor:
  resource: references/runner.md
  receipt: [input_hashes, evaluator_version, result]
attester:
  resource: references/attester.md
---

# Computation

This is a contract example. No executable evaluator is supplied or run by import.
A trusted implementation must define sampling, alignment, units and symmetric distances.
