import { OTPInput, OTPInputContext } from "input-otp";
import * as React from "react";
import { cn } from "@/lib/common/utils";

function InputOTP({
  className,
  containerClassName,
  ...props
}: React.ComponentProps<typeof OTPInput> & {
  containerClassName?: string;
}) {
  return (
    <OTPInput
      containerClassName={cn(
        "flex items-center gap-2 has-disabled:opacity-50",
        containerClassName,
      )}
      spellCheck={false}
      className={cn("disabled:cursor-not-allowed", className)}
      {...props}
    />
  );
}

function InputOTPGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div className={cn("flex items-center gap-2", className)} {...props} />
  );
}

function InputOTPSlot({
  index,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  index: number;
}) {
  const inputOTPContext = React.useContext(OTPInputContext);
  const { char, hasFakeCaret, isActive } = inputOTPContext?.slots[index] ?? {};

  return (
    <div
      data-active={isActive}
      className={cn(
        "relative flex size-11 items-center justify-center rounded-md border border-dark-700",
        "bg-dark-900 text-white text-base font-semibold transition-all outline-none",
        "aria-invalid:border-danger-600",
        "data-[active=true]:z-10 data-[active=true]:border-primary-500 data-[active=true]:ring-[3px] data-[active=true]:ring-primary-500/30",
        "data-[active=true]:aria-invalid:border-danger-600 data-[active=true]:aria-invalid:ring-danger-500/30",
        className,
      )}
      {...props}
    >
      {char}
      {hasFakeCaret && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-4 w-px animate-caret-blink bg-primary-300 duration-1000" />
        </div>
      )}
    </div>
  );
}

function InputOTPSeparator({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex items-center text-dark-500", className)}
      {...props}
    >
      <span aria-hidden>-</span>
    </div>
  );
}

export { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot };
