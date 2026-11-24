---
"@tinychat/frontend": patch
"@tinychat/backend": patch
---

The option to import Fireflies meetings while TinyCloud One is closed is now shown to owners on the web app. While the server import is off, the backend deletes every stored permission pair when it starts and answers the import routes with its own marked 404, and the app treats only that marked 404 as the import being off.

Details: TC-3905
