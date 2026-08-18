import { useState } from "react";
import { Button } from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import type { FileItem } from "@/types/sftp/sftpTypes";

interface PermissionsDialogProps {
  open: boolean;
  file: FileItem;
  onConfirm: (mode: number) => void;
  onCancel: () => void;
}

const PERM_BITS = [
  { label: "Read", value: 4 },
  { label: "Write", value: 2 },
  { label: "Execute", value: 1 },
] as const;

const GROUPS = ["Owner", "Group", "Other"] as const;

function permissionsToMode(permissions: string): number {
  if (!permissions || permissions.length < 9) return 0o644;
  let mode = 0;
  // Owner
  if (permissions[0] === "r") mode |= 0o400;
  if (permissions[1] === "w") mode |= 0o200;
  if (permissions[2] === "x" || permissions[2] === "s") mode |= 0o100;
  // Group
  if (permissions[3] === "r") mode |= 0o040;
  if (permissions[4] === "w") mode |= 0o020;
  if (permissions[5] === "x" || permissions[5] === "s") mode |= 0o010;
  // Other
  if (permissions[6] === "r") mode |= 0o004;
  if (permissions[7] === "w") mode |= 0o002;
  if (permissions[8] === "x" || permissions[8] === "t") mode |= 0o001;
  return mode;
}

function bitToBool(bit: number, mask: number): boolean {
  return (bit & mask) === mask;
}

function toggleBit(bits: number, mask: number, on: boolean): number {
  return on ? bits | mask : bits & ~mask;
}

export default function PermissionsDialog({
  open,
  file,
  onConfirm,
  onCancel,
}: PermissionsDialogProps) {
  const initial = permissionsToMode(file.permissions);
  const [ownerBits, setOwnerBits] = useState((initial >> 6) & 7);
  const [groupBits, setGroupBits] = useState((initial >> 3) & 7);
  const [otherBits, setOtherBits] = useState(initial & 7);
  const [stickyBit, setStickyBit] = useState((initial & 0o4000) !== 0);
  const [setgidBit, setSetgidBit] = useState((initial & 0o2000) !== 0);
  const [setuidBit, setSetuidBit] = useState((initial & 0o4000) !== 0);

  const computed =
    (ownerBits << 6) |
    (groupBits << 3) |
    otherBits |
    (stickyBit ? 0o1000 : 0) |
    (setgidBit ? 0o2000 : 0) |
    (setuidBit ? 0o4000 : 0);

  const octalStr = computed.toString(8).padStart(4, "0");

  const toggleGroup = (group: number, mask: number) => {
    const setter =
      group === 0 ? setOwnerBits : group === 1 ? setGroupBits : setOtherBits;
    setter((prev) => toggleBit(prev, mask, !bitToBool(prev, mask)));
  };

  const getGroupBits = (group: number) =>
    group === 0 ? ownerBits : group === 1 ? groupBits : otherBits;

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title="Change Permissions"
      maxWidth="max-w-md"
    >
      <div className="space-y-5">
        <p className="text-sm text-dark-300">
          <span className="text-white font-medium">{file.name}</span>
        </p>

        {/* Permission grid */}
        <div className="border border-dark-700 rounded-lg overflow-hidden">
          {/* Header */}
          <div className="grid grid-cols-[1fr_auto_auto_auto] bg-dark-800 text-xs text-dark-400">
            <div className="px-3 py-2" />
            <div className="px-4 py-2 text-center">Read</div>
            <div className="px-4 py-2 text-center">Write</div>
            <div className="px-4 py-2 text-center">Execute</div>
          </div>

          {GROUPS.map((group, gi) => {
            const bits = getGroupBits(gi);
            return (
              <div
                key={group}
                className="grid grid-cols-[1fr_auto_auto_auto] border-t border-dark-700"
              >
                <div className="px-3 py-2.5 text-sm text-dark-200 flex items-center">
                  {group}
                </div>
                {PERM_BITS.map((perm) => {
                  const on = bitToBool(bits, perm.value);
                  return (
                    <div
                      key={perm.value}
                      className="px-4 py-2.5 flex items-center justify-center"
                    >
                      <button
                        type="button"
                        onClick={() => toggleGroup(gi, perm.value)}
                        className={`w-5 h-5 rounded border text-xs flex items-center justify-center transition-colors ${
                          on
                            ? "bg-primary-600 border-primary-500 text-white"
                            : "bg-dark-800 border-dark-600 text-dark-500 hover:border-dark-500"
                        }`}
                        title={`${group} ${perm.label}: ${on ? "on" : "off"}`}
                      >
                        {on ? "\u2713" : ""}
                      </button>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Octal display + special bits */}
        <div className="flex items-center gap-4">
          <div className="flex-1">
            <label
              htmlFor="perm-octal"
              className="block text-xs text-dark-400 mb-1"
            >
              Octal
            </label>
            <div className="bg-dark-800 border border-dark-600 rounded px-3 py-1.5 text-white text-sm font-mono">
              {octalStr}
            </div>
          </div>
          <div className="flex gap-3 pt-4">
            <label className="flex items-center gap-1.5 text-xs text-dark-400 cursor-pointer">
              <input
                type="checkbox"
                checked={setuidBit}
                onChange={(e) => setSetuidBit(e.target.checked)}
                className="rounded bg-dark-700 border-dark-600 text-primary-500 focus:ring-primary-500"
              />
              SUID
            </label>
            <label className="flex items-center gap-1.5 text-xs text-dark-400 cursor-pointer">
              <input
                type="checkbox"
                checked={setgidBit}
                onChange={(e) => setSetgidBit(e.target.checked)}
                className="rounded bg-dark-700 border-dark-600 text-primary-500 focus:ring-primary-500"
              />
              SGID
            </label>
            <label className="flex items-center gap-1.5 text-xs text-dark-400 cursor-pointer">
              <input
                type="checkbox"
                checked={stickyBit}
                onChange={(e) => setStickyBit(e.target.checked)}
                className="rounded bg-dark-700 border-dark-600 text-primary-500 focus:ring-primary-500"
              />
              Sticky
            </label>
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-2 border-t border-dark-700">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={() => onConfirm(computed)}>Apply</Button>
        </div>
      </div>
    </Modal>
  );
}
