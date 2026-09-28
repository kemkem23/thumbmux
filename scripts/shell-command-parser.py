#!/usr/bin/env python3
"""Read shell command positions, never source/execute the inspected scripts.

This deliberately bounded lexer understands quotes, comments, continuations,
heredocs and opaque substitutions. It checks direct simple-command wiring, not
control-flow reachability or commands hidden inside eval/substitutions. Unknown
expansions cannot satisfy a required command. SCRIPT_DIR is a symbolic anchor;
this check does not certify the script's directory-discovery implementation.
Locale quotes use C-locale spelling, not translated catalog strings. ANSI-C
control escapes (\\c) are unsupported and fail closed.
"""
import re
import sys


class Word(list):
    def __init__(self, parts, raw, start=None):
        super().__init__(parts)
        self.raw = raw
        self.start = start
        self.end = None if start is None else start + len(raw)
        self.assignment = re.match(r"^([A-Za-z_]\w*)=", raw)


NOOP_COMMANDS = {":", "true", "false"}


class Shell:
    def __init__(self, source):
        self.source = source
        self.i = 0
        self.comment_spans = []
        self.recorded_commands = []
        self.variable_reads = set()

    def _record_comment(self):
        start = self.i
        end = self.source.find("\n", self.i)
        end = len(self.source) if end < 0 else end
        self.comment_spans.append((start, end))
        self.i = end

    def _record_command(self, words):
        if not words:
            return
        starts = [word.start for word in words if word.start is not None]
        ends = [word.end for word in words if word.end is not None]
        if not starts or not ends:
            return
        self.recorded_commands.append((min(starts), max(ends), words))

    def heredoc(self):
        self.i += 2
        tabs = self.source.startswith("-", self.i)
        self.i += int(tabs)
        while self.i < len(self.source) and self.source[self.i] in " \t":
            self.i += 1
        delimiter = self.word()
        if not delimiter or any(kind != "literal" for kind, _ in delimiter):
            raise ValueError("unsupported shell heredoc delimiter")
        return "".join(value for _, value in delimiter), tabs

    def heredoc_bodies(self, heredocs):
        for delimiter, tabs in heredocs:
            while self.i < len(self.source):
                end = self.source.find("\n", self.i)
                end = len(self.source) if end < 0 else end
                line = self.source[self.i:end]
                self.i = min(end + 1, len(self.source))
                if (line.lstrip("\t") if tabs else line) == delimiter:
                    break
            else:
                raise ValueError("unterminated shell heredoc")

    def command_substitution(self):
        # Token boundaries and heredoc bodies belong to the nested shell, too.
        # Nested simple commands are recorded for live_source but never yielded
        # to command_argv: substitutions stay opaque for required-command checks.
        heredocs = []
        words = []
        while self.i < len(self.source):
            c = self.source[self.i]
            if c == ")":
                if heredocs:
                    raise ValueError("missing shell heredoc body")
                self._record_command(words)
                self.i += 1
                return
            if c == "\n":
                self.i += 1
                self._record_command(words)
                words = []
                self.heredoc_bodies(heredocs)
                heredocs = []
            elif c == "#":
                self._record_comment()
            elif self.source.startswith("<<<", self.i):
                self.i += 3
            elif self.source.startswith("<<", self.i):
                heredocs.append(self.heredoc())
            elif c == "(":
                self.i += 1
                self.command_substitution()
            elif c.isspace():
                self.i += 1
            elif c in ";|&<>":
                if c in "<>":
                    self.i += 1
                    while self.i < len(self.source) and self.source[self.i] in "<>&":
                        self.i += 1
                    while self.i < len(self.source) and self.source[self.i] in " \t":
                        self.i += 1
                    if self.i < len(self.source) and not self.source[self.i].isspace() \
                            and self.source[self.i] not in ";|&()<>#":
                        self.word()
                else:
                    self._record_command(words)
                    words = []
                    self.i += 1
            else:
                words.append(self.word())
        raise ValueError("unterminated shell substitution")

    def substitution(self, end, command=True):
        """Consume a substitution as data, including nested quoting/substitutions."""
        if end == ")" and command:
            self.command_substitution()
            return
        while self.i < len(self.source):
            c = self.source[self.i]
            self.i += 1
            if c == end:
                return
            if c == "\\":
                self.i += 1
            elif c in "'\"`":
                self.quote(c)
            elif c == "$" and self.i < len(self.source) and self.source[self.i] in "({":
                opener = self.source[self.i]
                self.i += 1
                self.substitution(")" if opener == "(" else "}")
            elif c == "(" and end == ")":
                self.substitution(")", command=False)
        raise ValueError("unterminated shell substitution")

    def quote(self, quote):
        parts = []
        while self.i < len(self.source):
            c = self.source[self.i]
            self.i += 1
            if c == quote:
                return parts
            if quote != "'" and c == "\\":
                if self.i == len(self.source):
                    break
                c = self.source[self.i]
                self.i += 1
                if c != "\n":
                    if quote == '"' and c not in '$`"\\':
                        parts.append(("literal", "\\"))
                    parts.append(("literal", c))
            elif quote != "'" and c == "$":
                parts.append(self.dollar())
            elif quote == '"' and c == '`':
                self.quote('`')
                parts.append(("opaque", ""))
            else:
                parts.append(("literal", c))
        raise ValueError("unterminated shell quote")

    def ansi_quote(self):
        result = []
        escapes = {"a": "\a", "b": "\b", "e": "\x1b", "E": "\x1b",
                   "f": "\f", "n": "\n", "r": "\r", "t": "\t", "v": "\v",
                   "\\": "\\", "'": "'", '"': '"', "?": "?"}
        while self.i < len(self.source):
            c = self.source[self.i]
            self.i += 1
            if c == "'":
                # Bash strings cannot contain NUL; the rest of this quote is lost.
                return [("literal", "".join(result).split("\0", 1)[0])]
            if c != "\\":
                result.append(c)
                continue
            if self.i == len(self.source):
                break
            c = self.source[self.i]
            self.i += 1
            if c in escapes:
                result.append(escapes[c])
            elif c in "01234567":
                match = re.match(r"[0-7]{0,2}", self.source[self.i:])[0]
                self.i += len(match)
                result.append(chr(int(c + match, 8) % 256))
            elif c in "xuU":
                limit = {"x": 2, "u": 4, "U": 8}[c]
                match = re.match(r"[0-9a-fA-F]{1," + str(limit) + "}", self.source[self.i:])
                if match:
                    self.i += len(match[0])
                    result.append(chr(int(match[0], 16)))
                else:
                    result.append("\\" + c)
            elif c == "c":
                # Avoid guessing control escape/locale dependent byte semantics.
                raise ValueError("unsupported ANSI-C control escape")
            else:
                result.append("\\" + c)
        raise ValueError("unterminated ANSI-C shell quote")

    def dollar(self):
        if self.i < len(self.source) and self.source[self.i] == "(":
            self.i += 1
            # Arithmetic shift operators are not shell heredoc redirections.
            self.substitution(")", command=not self.source.startswith("(", self.i))
            return ("opaque", "")
        if self.i < len(self.source) and self.source[self.i] == "{":
            self.i += 1
            start = self.i
            self.substitution("}")
            name = self.source[start:self.i - 1]
            if re.fullmatch(r"[A-Za-z_]\w*", name):
                self.variable_reads.add(name)
                return ("variable", name)
            return ("opaque", "")
        match = re.match(r"[A-Za-z_]\w*", self.source[self.i:])
        if match:
            self.i += len(match[0])
            self.variable_reads.add(match[0])
            return ("variable", match[0])
        return ("literal", "$")

    def word(self):
        start = self.i
        parts = []
        while self.i < len(self.source):
            c = self.source[self.i]
            if c in "<>" and self.source[self.i + 1:self.i + 2] == "(":
                self.i += 2
                self.command_substitution()
                parts.append(("opaque", ""))
                continue
            if c.isspace() or c in ";|&()<>":
                break
            self.i += 1
            if c == "$" and self.source[self.i:self.i + 1] in {"'", '"'}:
                quote = self.source[self.i]
                self.i += 1
                # Locale quotes are interpreted under the C locale contract.
                parts.extend(self.ansi_quote() if quote == "'" else self.quote(quote))
            elif c in "'\"":
                parts.extend(self.quote(c))
            elif c == "`":
                self.quote(c)
                parts.append(("opaque", ""))
            elif c == "$":
                parts.append(self.dollar())
            elif c == "\\":
                if self.i == len(self.source):
                    raise ValueError("trailing shell escape")
                c = self.source[self.i]
                self.i += 1
                if c != "\n":
                    parts.append(("literal", c))
            else:
                parts.append(("literal", c))
        return Word(parts, self.source[start:self.i], start)

    def conditional(self):
        # [[ ... ]] operands are data even across && / || / newlines.
        self.i += 2
        while self.i < len(self.source):
            if self.source.startswith("]]", self.i):
                self.i += 2
                return
            if self.source[self.i].isspace() or self.source[self.i] in ";|&()<>":
                self.i += 1
            else:
                self.word()
        raise ValueError("unterminated shell conditional")

    def function_parentheses(self):
        """Look ahead for the empty token pair after a definition's name."""
        cursor = self.i
        for token in ("(", ")"):
            while cursor < len(self.source):
                if self.source.startswith("\\\n", cursor):
                    cursor += 2
                elif self.source[cursor] in " \t\r":
                    cursor += 1
                else:
                    break
            if self.source[cursor:cursor + 1] != token:
                return None
            cursor += 1
        return cursor

    def commands(self):
        words, heredocs = [], []
        case_patterns = []
        function_name = False
        while self.i < len(self.source):
            c = self.source[self.i]
            if self.source.startswith("[[", self.i) and self.source[self.i + 2:self.i + 3].isspace():
                self.conditional()
                words.append(Word([("opaque", "")], "[[...]]"))
            elif self.source.startswith("\\\n", self.i):
                self.i += 2
            elif c == "#":
                # Only reached at a word boundary: embedded '#' stays in word().
                self._record_comment()
            elif c == "\n":
                self.i += 1
                if words and not (case_patterns and case_patterns[-1]):
                    self._record_command(words)
                    yield words
                    words = []
                self.heredoc_bodies(heredocs)
                heredocs = []
            elif c.isspace():
                self.i += 1
            elif c in "<>" and self.source[self.i + 1:self.i + 2] == "(":
                words.append(self.word())
            elif self.source.startswith("<<", self.i) and not self.source.startswith("<<<", self.i):
                heredocs.append(self.heredoc())
            elif c in ";|&()<>":
                if case_patterns and case_patterns[-1]:
                    # An arm's quoted pattern is not an executable name.
                    self.i += 1
                    if c == ")":
                        case_patterns[-1] = False
                        words = []
                    continue
                if self.source.startswith(";;", self.i) and case_patterns:
                    case_patterns[-1] = True
                self.i += 1
                # Redirections do not end the surrounding simple command.
                if c in "<>":
                    while self.i < len(self.source) and self.source[self.i] in "<>&":
                        self.i += 1
                    while self.i < len(self.source) and self.source[self.i] in " \t":
                        self.i += 1
                    self.word()
                elif words:
                    self._record_command(words)
                    yield words
                    words = []
            else:
                word = self.word()
                # A compound assignment's parenthesis belongs to its value,
                # not to a subshell. Consume the balanced value as opaque data
                # and clear any earlier scalar alias for the assigned name.
                array = re.fullmatch(r"([A-Za-z_]\w*)(?:\+)?=", word.raw.replace("\\\n", ""))
                if array and self.source[self.i:self.i + 1] == "(":
                    self.i += 1
                    self.command_substitution()
                    words.append(Word([("opaque", "")], array[1] + "=", word.start))
                    continue
                # Only a word in command position can introduce a function.
                # Keep the body in this walk: calls inside it still count.
                command_position = all(w.raw in {"then", "do", "else", "elif", "if", "!", "{"}
                                       for w in words)
                if not (case_patterns and case_patterns[-1]):
                    if function_name:
                        function_name = False
                        self.i = self.function_parentheses() or self.i
                        continue
                    if command_position and word.raw == "function":
                        function_name = True
                        continue
                    end = self.function_parentheses() if command_position else None
                    if end is not None:
                        self.i = end
                        continue
                words.append(word)
                if word.raw == "in" and words[0].raw == "case":
                    case_patterns.append(True)
                    words = []
                elif word.raw == "esac" and case_patterns:
                    case_patterns.pop()
                    words = []
        if heredocs:
            raise ValueError("missing shell heredoc body")
        if words:
            self._record_command(words)
            yield words


def live_source(source):
    """Original source with comments, no-op commands, and unread assignments blanked.

    Newlines stay so line-oriented grep still lines up. Heredoc bodies and
    quoted strings keep their text, including lines that look like comments.
    command_argv is unchanged: substitutions remain opaque for require-command.
    """
    shell = Shell(source)
    list(shell.commands())
    dead = list(shell.comment_spans)
    used = shell.variable_reads
    for start, end, words in shell.recorded_commands:
        argv0 = None
        assignment_names = []
        only_assignments = True
        for word in words:
            if word.assignment:
                assignment_names.append(word.assignment.group(1))
            elif argv0 is None:
                argv0 = word.raw
                only_assignments = False
            else:
                only_assignments = False
        if argv0 in NOOP_COMMANDS:
            dead.append((start, end))
        elif only_assignments and assignment_names and all(name not in used for name in assignment_names):
            literal_only = all(all(kind == "literal" for kind, _ in word) for word in words)
            if literal_only:
                dead.append((start, end))
    chars = list(source)
    for start, end in dead:
        for index in range(start, min(end, len(chars))):
            if chars[index] != "\n":
                chars[index] = " "
    return "".join(chars)


def command_argv(source):
    variables = {"SCRIPT_DIR": "<SCRIPT_DIR>"}
    for words in Shell(source).commands():
        def expand(parts):
            result = ""
            for kind, value in parts:
                if kind == "opaque" or (kind == "variable" and value not in variables):
                    return None
                result += variables[value] if kind == "variable" else value
            return result

        argv = [expand(word) for word in words]
        while argv and words[0].raw == argv[0] and argv[0] in {"then", "do", "else", "elif", "if", "!", "{", "while", "until"}:
            argv.pop(0)
            words.pop(0)
        assignments = {}
        while words:
            # Assignment names must be unexpanded text; unresolved RHS clears aliases.
            match = words[0].assignment
            if not match:
                break
            name = match[1]
            value = argv.pop(0)
            words.pop(0)
            assignments[name] = value[len(name) + 1:] if value is not None else None
        if not argv:
            for name, value in assignments.items():
                if name == "SCRIPT_DIR":
                    continue  # symbolic anchor, as documented above
                if value is None:
                    variables.pop(name, None)
                else:
                    variables[name] = value
        else:
            yield argv


# Package-local parser: the public split has no monorepo ops/ directory.
# Derived from ops/testing/tests/command-cage-wiring.py at de7d12e60.
