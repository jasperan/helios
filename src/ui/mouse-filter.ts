import { Transform } from "node:stream";
import { EventEmitter } from "node:events";

export interface MouseEvent {
  type: "scroll_up" | "scroll_down" | "click" | "release" | "move";
  x: number;
  y: number;
  button: number;
}

/**
 * Creates a Transform stream that strips SGR mouse escape sequences
 * from stdin before Ink can see them. Mouse events are emitted on a
 * separate EventEmitter so the app can handle them.
 *
 * This must be set up BEFORE Ink's render() so Ink receives the
 * filtered stream as its stdin.
 */
export function createMouseFilter(stdin: NodeJS.ReadStream) {
  const mouseEmitter = new EventEmitter();

  // SGR mouse format: ESC [ < button ; x ; y M (press) or m (release)
  const SGR_MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

  const filteredStdin = new Transform({
    transform(chunk, _encoding, callback) {
      const str = chunk.toString();

      // Parse and emit mouse events
      let match: RegExpExecArray | null;
      SGR_MOUSE_RE.lastIndex = 0;
      while ((match = SGR_MOUSE_RE.exec(str)) !== null) {
        const button = parseInt(match[1], 10);
        const x = parseInt(match[2], 10);
        const y = parseInt(match[3], 10);
        const isPress = match[4] === "M";

        let type: MouseEvent["type"];
        if (button === 64) type = "scroll_up";
        else if (button === 65) type = "scroll_down";
        else if (button >= 32 && button < 64) type = "move";
        else if (isPress) type = "click";
        else type = "release";

        mouseEmitter.emit("mouse", { type, x, y, button } satisfies MouseEvent);
      }

      // Strip all mouse sequences from the data
      const cleaned = str.replace(SGR_MOUSE_RE, "");
      if (cleaned.length > 0) {
        this.push(Buffer.from(cleaned));
      }
      callback();
    },
  });

  // Proxy all TTY methods/properties Ink expects on stdin
  const f = filteredStdin as any;
  f.isTTY = stdin.isTTY;
  f.setRawMode = (mode: boolean) => {
    if (typeof stdin.setRawMode === "function") {
      stdin.setRawMode(mode);
    }
    return filteredStdin;
  };
  f.setEncoding = (enc: string) => {
    stdin.setEncoding(enc as BufferEncoding);
    return filteredStdin;
  };
  f.ref = () => { stdin.ref(); return filteredStdin; };
  f.unref = () => { stdin.unref(); return filteredStdin; };

  // Pipe raw stdin through the filter
  stdin.pipe(filteredStdin);

  return { filteredStdin, mouseEmitter };
}
