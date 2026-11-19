---
"@tinychat/frontend": patch
---

On a phone, the Feed opens one row at a time. Opening a row folds the one that was open, dims the others and brings the open row up under its section heading. "Show less" at the foot of an open card folds it and brings its row back into view. With reduced motion nothing animates, and the open row still comes into view. An answer that's still counting down is still sent when you open another row.

Details: TC-3300
