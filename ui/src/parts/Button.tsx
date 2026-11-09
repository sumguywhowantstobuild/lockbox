import type { ComponentPropsWithRef } from "react";

/** How a button looks: the one main action of a screen, a quiet pill, the pill that is the main action of a panel. */
export type ButtonLook = "main" | "pill" | "pill-main";

const CLASS: Record<ButtonLook, string> = {
  main: "prim",
  pill: "pill",
  "pill-main": "pill t cp",
};

/** A button that does not submit a form unless it is told to: `type` is "button" unless given. */
export function Button({
  look = "pill",
  type = "button",
  className,
  ...rest
}: ComponentPropsWithRef<"button"> & { look?: ButtonLook }) {
  return <button {...rest} type={type} className={[CLASS[look], className].filter(Boolean).join(" ")} />;
}
