# Security

## Reporting a problem

Please report security problems privately, through "Report a vulnerability" under this
repository's Security tab, and not in a public issue. Include the request or the manifest
that shows the problem if you can.

Things worth reporting:

- a way to make the server fetch a private, local or link-local address;
- a way to use `/img` or any tool as a general proxy for content that did not come from a
  IIIF manifest;
- a way to get an API key, or anything from the operator's environment, into a response;
- manifest or search text that reaches a model without the `untrusted_content` note, or
  with hidden characters intact.

## What the server does and does not promise

- It is read-only and has no login. It holds no user data.
- Text from manifests and search results is written by third parties and is treated as
  untrusted: see "Untrusted content" in the README. That lowers the risk of prompt
  injection. It cannot remove it, and the pattern list only catches crude attempts.
- The private-address guard is described under "How it stays a polite client" in the
  README. When the server is run locally it narrows DNS-based tricks but cannot fully
  close them, because a name can resolve differently a moment later.

## If you run an institution's servers

If a deployment of this software is causing you trouble, the operator's contact is in the
User-Agent of every request it sends (`whatiiif-mcp/x.y.z (contact)`), and on the front
page of the deployment itself. For a problem with the software's behaviour in general,
open an issue here.
