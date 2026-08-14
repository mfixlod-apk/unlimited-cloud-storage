import { CloudIcon } from "../icons";

export function Brand({ onClick }: { onClick?: () => void }) {
  const content = <><span className="brand-mark"><CloudIcon /></span><span>Unlimited Cloud<br />Storage</span></>;
  return onClick ? <button className="brand brand-button" onClick={onClick} aria-label="Go to home page">{content}</button> : <div className="brand">{content}</div>;
}
