# Live-window reflow

Terminal geometry follows the mounted terminal view. When its column count changes, the server resizes the tmux window and sends a complete `output` frame with `reset: "resize"`; it never sends a delta for that replacement.

Only the current live window is re-captured and reflowed. Older rows already placed in the history archive remain the physical rows captured at their original width. This preserves archived content and avoids rewriting history, but it also means archived text does not retrospectively rewrap to match a later terminal width.

The client replaces the live window as one unit, retains archived rows, preserves a bottom-pinned view at offset zero, and does not append the old and reflowed live captures together.
