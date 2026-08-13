import type { SVGProps } from "react";

type Props = SVGProps<SVGSVGElement>;

const Icon = ({ children, ...props }: Props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    {children}
  </svg>
);

export const CloudIcon = (props: Props) => <Icon {...props}><path d="M6.2 18.2h11.1a4.7 4.7 0 0 0 .6-9.3A6.4 6.4 0 0 0 5.5 8a5.1 5.1 0 0 0 .7 10.2Z"/><path d="m9 13 3-3 3 3M12 10v6"/></Icon>;
export const GridIcon = (props: Props) => <Icon {...props}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></Icon>;
export const ImageIcon = (props: Props) => <Icon {...props}><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m4 17 5-5 4 4 2-2 5 4"/></Icon>;
export const VideoIcon = (props: Props) => <Icon {...props}><rect x="3" y="5" width="14" height="14" rx="2"/><path d="m17 10 4-2v8l-4-2z"/></Icon>;
export const FileIcon = (props: Props) => <Icon {...props}><path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5M9 13h6M9 17h4"/></Icon>;
export const MusicIcon = (props: Props) => <Icon {...props}><path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></Icon>;
export const UploadIcon = (props: Props) => <Icon {...props}><path d="M12 16V4m0 0L7 9m5-5 5 5"/><path d="M4 15v5h16v-5"/></Icon>;
export const SearchIcon = (props: Props) => <Icon {...props}><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></Icon>;
export const SettingsIcon = (props: Props) => <Icon {...props}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></Icon>;
export const MoreIcon = (props: Props) => <Icon {...props}><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/></Icon>;
export const DownloadIcon = (props: Props) => <Icon {...props}><path d="M12 3v12m0 0 5-5m-5 5-5-5M4 20h16"/></Icon>;
export const TrashIcon = (props: Props) => <Icon {...props}><path d="M4 7h16M9 7V4h6v3m3 0-1 14H7L6 7M10 11v6M14 11v6"/></Icon>;
export const EditIcon = (props: Props) => <Icon {...props}><path d="m4 16.5-.8 4.3 4.3-.8L19 8.5 15.5 5 4 16.5Z"/><path d="m13.8 6.7 3.5 3.5"/></Icon>;
export const CloseIcon = (props: Props) => <Icon {...props}><path d="m6 6 12 12M18 6 6 18"/></Icon>;
export const CheckIcon = (props: Props) => <Icon {...props}><path d="m5 12 4 4L19 6"/></Icon>;
export const ChevronIcon = (props: Props) => <Icon {...props}><path d="m9 18 6-6-6-6"/></Icon>;
export const ShieldIcon = (props: Props) => <Icon {...props}><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/><path d="m9 12 2 2 4-4"/></Icon>;
export const RefreshIcon = (props: Props) => <Icon {...props}><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></Icon>;
export const FolderIcon = (props: Props) => <Icon {...props}><path d="M3 6h7l2 2h9v11H3z"/></Icon>;
export const EyeIcon = (props: Props) => <Icon {...props}><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></Icon>;
export const EyeOffIcon = (props: Props) => <Icon {...props}><path d="m3 3 18 18M10.6 10.7a2 2 0 0 0 2.7 2.7M9.9 5.2A9.8 9.8 0 0 1 12 5c6 0 10 7 10 7a16 16 0 0 1-2.1 2.8M6.6 6.6C3.8 8.5 2 12 2 12s4 7 10 7a9.7 9.7 0 0 0 3.4-.6"/></Icon>;
export const PlusIcon = (props: Props) => <Icon {...props}><path d="M12 5v14M5 12h14"/></Icon>;
export const CalendarIcon = (props: Props) => <Icon {...props}><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/></Icon>;
export const TelegramIcon = (props: Props) => <Icon {...props}><path d="m3 11.2 17.2-7-3.1 15.6-5.2-4.1-2.7 2.6.4-4.7 8.2-6.2-10.1 5.1Z"/></Icon>;
export const BrowserIcon = (props: Props) => <Icon {...props}><rect x="2.5" y="4" width="19" height="16" rx="2"/><path d="M2.5 8h19M6 6h.01M9 6h.01"/></Icon>;
export const PhoneIcon = (props: Props) => <Icon {...props}><rect x="6" y="2" width="12" height="20" rx="2"/><path d="M10 5h4M11 19h2"/></Icon>;
export const KeyIcon = (props: Props) => <Icon {...props}><circle cx="7.5" cy="15.5" r="4"/><path d="m10.5 12.5 9-9M16 7l2 2M13.5 9.5l2 2"/></Icon>;
