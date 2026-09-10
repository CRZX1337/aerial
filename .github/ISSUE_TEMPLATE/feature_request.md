name: Feature request
description: Suggest an idea for Aerial
labels: [enhancement]
body:
  - type: textarea
    id: problem
    attributes:
      label: What problem does this solve?
      description: Describe the user-facing problem before proposing a solution.
      placeholder: I can't … / It's annoying that …
    validations:
      required: true
  - type: textarea
    id: solution
    attributes:
      label: What should the solution look like?
    validations:
      required: true
  - type: checkboxes
    id: constraints
    attributes:
      label: Scope check
      options:
        - label: This keeps Aerial a pure player (no hosting / proxying of IPTV content)
          required: true
