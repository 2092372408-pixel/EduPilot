"""Trusted local teaching harness. Static precheck remains mandatory; this is not an OS sandbox."""
import json
import sys


class LimitedOutput:
    encoding = "utf-8"

    def __init__(self):
        self.text = ""

    def write(self, value):
        self.text += value[:max(0, 8000 - len(self.text))]
        return len(value)

    def flush(self):
        pass


def main():
    request = json.loads(sys.stdin.read())
    output, errors = LimitedOutput(), LimitedOutput()
    original_out, original_err = sys.stdout, sys.stderr
    write = original_out.write
    evaluate, execute, compile_source = eval, exec, compile
    scope = {"__name__": "__student__"}
    try:
        sys.stdout, sys.stderr = output, errors
        execute(compile_source(request["code"], "<student>", "exec"), scope)
        checks = [evaluate(expression, scope) is True for expression in request["checks"]]
    except BaseException as error:
        sys.stdout, sys.stderr = original_out, original_err
        write("EDUPILOT_CHECKS:ERROR\n" + output.text)
        original_err.write(type(error).__name__ + ": " + str(error))
        return 1
    finally:
        sys.stdout, sys.stderr = original_out, original_err
    # Student prints were redirected and cannot be mistaken for the first protocol line.
    write("EDUPILOT_CHECKS:" + "".join("1" if passed else "0" for passed in checks) + "\n" + output.text)
    original_err.write(errors.text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
