name: Bug report
description: Something does not work as expected
labels: [bug]
body:
  - type: textarea
    id: what-happened
    attributes:
      label: What happened?
      description: A clear description of the bug. Include the exact error message if one is shown.
      placeholder: |
        Steps to reproduce:
        1. ...
        2. ...
    validations:
      required: true
  - type: dropdown
    id: provider-type
    attributes:
      label: Provider type
      options:
        - Xtream Codes
        - M3U / M3U8
        - Both / multiple profiles
        - No provider connected yet
    validations:
      required: true
  - type: input
    id: environment
    attributes:
      label: Environment
      description: e.g. "iOS 18, Safari, installed PWA" or "Windows 11, Chrome 130"
      placeholder: OS + browser (+ installed as PWA?)
    validations:
      required: true
  - type: textarea
    id: provider-details
    attributes:
      label: Provider behavior (if provider-related)
      description: |
        Does the provider send CORS headers? Is it HTTP or HTTPS? Never post
        credentials, passwords or full stream URLs with embedded logins!
      placeholder: "Provider serves HTTPS and allows CORS on player_api.php…"
  - type: textarea
    id: logs
    attributes:
      label: Relevant log output
      description: Browser console output — redact any URLs that contain credentials.
      render: shell
