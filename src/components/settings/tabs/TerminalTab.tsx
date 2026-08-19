import Checkbox from "@/components/ui/Checkbox";
import Select from "@/components/ui/Select";
import Slider from "@/components/ui/Slider";
import type { TerminalTabProps } from "@/types/settings/types";

export default function TerminalTab({
  cursorStyle,
  cursorBlink,
  scrollback,
  bellStyle,
  setCursorStyle,
  setCursorBlink,
  setScrollback,
  setBellStyle,
}: TerminalTabProps) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium text-white mb-3">Cursor</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="cursor-style"
              className="block text-dark-300 text-sm mb-2"
            >
              Cursor Style
            </label>
            <Select
              id="cursor-style"
              value={cursorStyle}
              onValueChange={setCursorStyle}
              options={[
                { value: "block", label: "Block" },
                { value: "underline", label: "Underline" },
                { value: "bar", label: "Bar" },
              ]}
            />
          </div>
          <div className="flex items-end">
            <label
              htmlFor="cursor-blink"
              className="flex items-center gap-2 cursor-pointer"
            >
              <Checkbox
                id="cursor-blink"
                checked={cursorBlink}
                onCheckedChange={setCursorBlink}
              />
              <span className="text-sm text-white">Cursor Blink</span>
            </label>
          </div>
        </div>
      </div>

      <div className="border-t border-dark-700 pt-6">
        <h3 className="text-sm font-medium text-white mb-3">Scrollback</h3>
        <div>
          <div className="flex items-center justify-between mb-2">
            <label htmlFor="scrollback" className="text-dark-300 text-sm">
              Scrollback Lines
            </label>
            <span className="text-xs text-dark-400 tabular-nums">
              {scrollback.toLocaleString()}
            </span>
          </div>
          <Slider
            id="scrollback"
            value={scrollback}
            onValueChange={setScrollback}
            min={1000}
            max={100000}
            step={1000}
          />
        </div>
      </div>

      <div className="border-t border-dark-700 pt-6">
        <h3 className="text-sm font-medium text-white mb-3">Bell Style</h3>
        <Select
          value={bellStyle}
          onValueChange={setBellStyle}
          options={[
            { value: "none", label: "None" },
            { value: "sound", label: "Sound" },
            { value: "visual", label: "Visual Flash" },
          ]}
          className="max-w-xs"
        />
      </div>
    </div>
  );
}
