import { UploadSimpleIcon, XIcon } from "@phosphor-icons/react";
import { useId } from "react";
import { useDropzone } from "react-dropzone";
import { cn } from "@/lib/common/utils";

interface FileInputProps {
  value?: File | null;
  onValueChange?: (file: File | null) => void;
  accept?: Record<string, string[]>;
  maxSize?: number;
  placeholder?: string;
  description?: string;
  disabled?: boolean;
  className?: string;
}

export default function FileInput({
  value,
  onValueChange,
  accept,
  maxSize,
  placeholder = "Drop a file here or ",
  description,
  disabled = false,
  className,
}: FileInputProps) {
  const id = useId();

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: (files) => {
      onValueChange?.(files[0] ?? null);
    },
    accept,
    maxSize,
    multiple: false,
    disabled,
  });

  const hasFile = value instanceof File;

  return (
    <div className={cn("space-y-2", className)}>
      <div
        {...getRootProps()}
        className={cn(
          "border-2 border-dashed rounded-md p-6 text-center cursor-default transition-colors",
          isDragActive
            ? "border-primary-500 bg-primary-500/10"
            : "border-dark-600 hover:border-dark-500 hover:bg-dark-800",
          disabled && "opacity-50 cursor-not-allowed",
          hasFile && "border-dark-500 bg-dark-800",
        )}
      >
        <input id={id} {...getInputProps()} />

        {hasFile ? (
          <div className="flex items-center justify-center gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-sm text-white truncate">{value.name}</p>
              <p className="text-xs text-dark-400 mt-0.5">
                {(value.size / 1024).toFixed(1)} KB
              </p>
            </div>
            <button
              type="button"
              aria-label="Remove file"
              onClick={(e) => {
                e.stopPropagation();
                onValueChange?.(null);
              }}
              className="p-1 text-dark-400 hover:text-white rounded transition-colors"
            >
              <XIcon className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <>
            <UploadSimpleIcon
              className="w-10 h-10 mx-auto mb-3 text-dark-400"
              weight="bold"
            />
            <p className="text-sm text-dark-300">
              {isDragActive ? (
                "Drop the file here"
              ) : (
                <>
                  {placeholder}
                  <span className="text-primary-500">browse</span>
                </>
              )}
            </p>
            {description && (
              <p className="mt-1 text-xs text-dark-500">{description}</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
