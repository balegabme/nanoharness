name: Bug report
description: Something is broken or behaves unexpectedly
labels: ["bug"]
body:
  - type: textarea
    id: what-happened
    attributes:
      label: What happened?
      description: A clear description of the bug. Include expected vs actual behavior.
      placeholder: |
        Expected:
        Actual:
    validations:
      required: true
  - type: textarea
    id: steps
    attributes:
      label: Steps to reproduce
      placeholder: |
        1.
        2.
    validations:
      required: true
  - type: textarea
    id: logs
    attributes:
      label: Relevant output
      description: Console output, error text, or screenshots. Redact secrets.
  - type: textarea
    id: environment
    attributes:
      label: Environment
      placeholder: OS, NanoHarness version, Node/pnpm versions, provider/model
    validations:
      required: true
