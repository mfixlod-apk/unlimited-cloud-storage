import { useCallback, useEffect, useRef, useState } from "react";
import { localStore } from "./storage";
import { telegramDrive, type CloudChannel, type TelegramCredentials } from "./telegram";
import { DriveScreen } from "./screens/DriveScreen";
import { AuthScreen, ChannelScreen, LandingScreen, LoadingScreen } from "./screens/OnboardingScreens";
import { friendlyError, type Theme } from "./screens/shared";

type Stage = "boot" | "credentials" | "auth" | "channels" | "drive" | "home";

export default function App() {
  const [theme, setTheme] = useState<Theme>(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const [stage, setStage] = useState<Stage>("boot");
  const [credentials, setCredentials] = useState<TelegramCredentials>();
  const [remember, setRemember] = useState(false);
  const [account, setAccount] = useState<any>();
  const [channels, setChannels] = useState<CloudChannel[]>([]);
  const [channel, setChannel] = useState<CloudChannel>();
  const [showPublicChannels, setShowPublicChannels] = useState(false);
  const [error, setError] = useState("");
  const driveScrollPosition = useRef(0);

  useEffect(() => {
    void localStore.getTheme().then((saved) => { if (saved) setTheme(saved); });
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#181816" : "#f7f7f4");
  }, [theme]);

  const changeTheme = async (next: Theme) => {
    setTheme(next);
    await localStore.saveTheme(next);
  };

  const prepareAccount = useCallback(async () => {
    const [me, availableChannels, savedChannelId] = await Promise.all([
      telegramDrive.getMe(),
      telegramDrive.listPrivateChannels(),
      localStore.getChannelId(),
    ]);
    setAccount(me);
    setChannels(availableChannels);
    const restoredChannel = availableChannels.find((entry) => entry.id === savedChannelId);
    if (restoredChannel) {
      setChannel(restoredChannel);
      setStage("drive");
    } else {
      setStage("channels");
    }
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const saved = await localStore.getConnection();
        if (!saved) {
          if (active) setStage("credentials");
          return;
        }
        const restored = { apiId: saved.apiId, apiHash: saved.apiHash };
        if (active) setCredentials(restored);
        const authorized = await telegramDrive.connect(restored, saved.session);
        if (!active) return;
        if (authorized) await prepareAccount();
        else setStage("auth");
      } catch (cause) {
        await telegramDrive.disconnect();
        if (active) {
          setError(`We couldn't restore this device: ${friendlyError(cause)}`);
          setStage("credentials");
        }
      }
    })();
    return () => { active = false; };
  }, [prepareAccount]);

  const handleCredentials = async (next: TelegramCredentials, keepSignedIn: boolean) => {
    setError("");
    setCredentials(next);
    setRemember(keepSignedIn);
    setStage("boot");
    try {
      const authorized = await telegramDrive.connect(next);
      if (authorized) await prepareAccount();
      else setStage("auth");
    } catch (cause) {
      setError(friendlyError(cause));
      setStage("credentials");
    }
  };

  const handleAuthenticated = async () => {
    if (!credentials) return;
    if (remember) {
      await localStore.saveConnection({ ...credentials, session: telegramDrive.sessionString() });
    } else {
      await localStore.clearConnection();
    }
    await prepareAccount();
  };

  const chooseChannel = async (next: CloudChannel) => {
    if (!next.canWrite) return;
    if (next.isPublic && !window.confirm(`“${next.title}” is public. Files uploaded there may be visible to every subscriber. Use this channel anyway?`)) return;
    setChannel(next);
    await localStore.saveChannelId(next.id);
    setStage("drive");
  };

  const createChannel = async (title: string) => {
    const created = await telegramDrive.createPrivateChannel(title);
    setChannels((current) => [created, ...current.filter((entry) => entry.id !== created.id)]);
    return created;
  };

  const renameChannel = async (target: CloudChannel, title: string) => {
    const renamed = await telegramDrive.renameChannel(target, title);
    setChannels((current) => current.map((entry) => entry.id === renamed.id ? renamed : entry));
    setChannel((current) => current?.id === renamed.id ? renamed : current);
    return renamed;
  };

  const deleteChannel = async (target: CloudChannel) => {
    await telegramDrive.deleteChannel(target);
    try {
      const [uploadRecords, uploadBatches] = await Promise.all([
        localStore.getUploadRecords(target.id),
        localStore.getUploadBatches(target.id),
      ]);
      await Promise.allSettled([
        localStore.deleteUploadRecords(uploadRecords.map((record) => record.id)),
        ...uploadBatches.map((batch) => localStore.deleteUploadBatch(batch.id)),
      ]);
    } catch {
      // Telegram is authoritative; stale local queue metadata is harmless and
      // will be removed by Forget browser/site-data cleanup.
    }
    setChannels((current) => current.filter((entry) => entry.id !== target.id));
    if (channel?.id === target.id) {
      await localStore.clearChannelId();
      setChannel(undefined);
      setStage("channels");
    }
  };

  const refreshChannelList = async () => {
    setChannels(await telegramDrive.listPrivateChannels());
  };

  const openHome = () => {
    if (stage === "drive") driveScrollPosition.current = window.scrollY;
    setStage("home");
    window.setTimeout(() => window.scrollTo({ top: 0 }), 0);
  };

  const openWorkspace = () => {
    const nextStage = channel ? "drive" : "channels";
    setStage(nextStage);
    if (nextStage === "drive") window.setTimeout(() => window.scrollTo({ top: driveScrollPosition.current }), 0);
  };

  const forgetDevice = async () => {
    await telegramDrive.disconnect();
    await localStore.clearAll();
    await localStore.saveTheme(theme);
    setCredentials(undefined);
    setAccount(undefined);
    setChannels([]);
    setChannel(undefined);
    setStage("credentials");
  };

  const logOut = async () => {
    try { await telegramDrive.logOut(); } catch { await telegramDrive.disconnect(); }
    await localStore.clearAll();
    await localStore.saveTheme(theme);
    setCredentials(undefined);
    setAccount(undefined);
    setChannel(undefined);
    setStage("credentials");
  };

  if (stage === "boot") return <LoadingScreen />;
  if (stage === "credentials") return <LandingScreen initial={credentials} externalError={error} onContinue={handleCredentials} />;
  if (stage === "auth") return <AuthScreen onComplete={handleAuthenticated} onBack={() => { telegramDrive.disconnect(); setStage("credentials"); }} />;
  if (stage === "channels") return <ChannelScreen account={account} channels={channels} showPublic={showPublicChannels} onShowPublic={setShowPublicChannels} onChoose={chooseChannel} onCreate={createChannel} onRefresh={refreshChannelList} onHome={openHome} onBack={logOut} />;
  if (stage === "home" && account && !channel) return <LandingScreen initial={credentials} externalError="" account={account} onContinue={handleCredentials} onOpenWorkspace={openWorkspace} onLogOut={logOut} onSwitchAccount={logOut} />;
  if (!channel) return null;
  return (
    <>
      <div className="drive-host" hidden={stage === "home"}>
        <DriveScreen
          key={channel.id}
          account={account}
          channel={channel}
          channels={channels}
          showPublicChannels={showPublicChannels}
          onShowPublicChannels={setShowPublicChannels}
          onSelectChannel={chooseChannel}
          onCreateChannel={createChannel}
          onRenameChannel={renameChannel}
          onDeleteChannel={deleteChannel}
          onChangeChannel={() => setStage("channels")}
          onForget={forgetDevice}
          onLogOut={logOut}
          onHome={openHome}
          theme={theme}
          onTheme={changeTheme}
        />
      </div>
      {stage === "home" && account && <LandingScreen initial={credentials} externalError="" account={account} onContinue={handleCredentials} onOpenWorkspace={openWorkspace} onLogOut={logOut} onSwitchAccount={logOut} />}
    </>
  );
}
