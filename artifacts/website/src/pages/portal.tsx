import { useEffect, useRef, useState } from 'react';
import { useSpeechInput, useSpeechOutput } from '@/hooks/use-voice';
import { motion, AnimatePresence } from 'framer-motion';
import {
  useRequestPortalLoginCode,
  useVerifyPortalLoginCode,
  useGetPortalOverview,
  useGetPortalPhoto,
  useSendPortalMessage,
  useGetPortalConversation,
  getGetPortalConversationQueryKey,
  useLogoutPortalSession,
  useAddPortalClaimPhotos,
  requestPublicUploadUrl,
  getGetPortalOverviewQueryKey,
} from '@workspace/api-client-react';
import type { PortalClaim } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  CalendarClock,
  Check,
  CheckCircle2,
  Circle,
  Camera,
  Home,
  ImagePlus,
  LoaderCircle,
  LogOut,
  MapPin,
  MessageSquare,
  Mic,
  MicOff,
  ShieldCheck,
  Volume2,
  VolumeX,
} from 'lucide-react';

const TOKEN_KEY = 'painless_portal_token';

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

function apiError(err: unknown): string {
  const data = (err as { data?: { error?: string } } | null)?.data;
  return data?.error ?? 'Something went wrong. Please try again.';
}

const dateFmt = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});
const timeFmt = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
});

const MAX_PHOTOS_PER_BATCH = 10;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // 10MB — matches the API limit
const ALLOWED_PHOTO_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
];

const APPOINTMENT_LABELS: Record<string, string> = {
  inspection: 'Roof inspection',
  estimate_review: 'Estimate review',
  production: 'Repair crew visit',
  final_walkthrough: 'Final walkthrough',
  other: 'Appointment',
};

/* ---------------------------------- Login --------------------------------- */

function LoginCard({ onAuthed }: { onAuthed: (token: string) => void }) {
  const [identifier, setIdentifier] = useState('');
  const [code, setCode] = useState('');
  const [phase, setPhase] = useState<'identifier' | 'code'>('identifier');
  const [channel, setChannel] = useState<'email' | 'sms'>('email');
  const [error, setError] = useState<string | null>(null);

  const requestCode = useRequestPortalLoginCode();
  const verifyCode = useVerifyPortalLoginCode();

  const handleRequest = () => {
    setError(null);
    requestCode.mutate(
      { data: { identifier: identifier.trim() } },
      {
        onSuccess: (res) => {
          setChannel(res.channel);
          setPhase('code');
        },
        onError: (err) => setError(apiError(err)),
      },
    );
  };

  const handleVerify = () => {
    setError(null);
    verifyCode.mutate(
      { data: { identifier: identifier.trim(), code: code.trim() } },
      {
        onSuccess: (res) => {
          window.localStorage.setItem(TOKEN_KEY, res.token);
          onAuthed(res.token);
        },
        onError: (err) => setError(apiError(err)),
      },
    );
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      className="max-w-md mx-auto bg-card p-8 md:p-10 rounded-3xl border border-card-border shadow-2xl"
    >
      <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center mb-6">
        <ShieldCheck className="w-7 h-7 text-primary" />
      </div>
      <h1 className="text-3xl font-display font-bold mb-2">Claim Portal</h1>
      <p className="text-muted-foreground mb-8">
        Follow your roof claim from leak to repair. Sign in with the email or
        phone number from your assessment.
      </p>

      {phase === 'identifier' ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleRequest();
          }}
          className="space-y-4"
        >
          <Input
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder="Email or phone number"
            autoComplete="email"
            className="h-12"
            data-testid="input-portal-identifier"
          />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <Button
            type="submit"
            size="lg"
            className="w-full h-12"
            disabled={requestCode.isPending || identifier.trim().length < 3}
            data-testid="button-portal-request-code"
          >
            {requestCode.isPending ? (
              <LoaderCircle className="w-5 h-5 animate-spin" />
            ) : (
              'Send sign-in code'
            )}
          </Button>
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleVerify();
          }}
          className="space-y-4"
        >
          <p className="text-sm text-muted-foreground">
            If we found a matching record, a 6-digit code was sent by{' '}
            {channel === 'email' ? 'email' : 'text message'}. Enter it below —
            it expires in 10 minutes.
          </p>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="6-digit code"
            inputMode="numeric"
            className="h-12 text-center text-xl tracking-[0.5em]"
            data-testid="input-portal-code"
          />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <Button
            type="submit"
            size="lg"
            className="w-full h-12"
            disabled={verifyCode.isPending || code.length !== 6}
            data-testid="button-portal-verify-code"
          >
            {verifyCode.isPending ? (
              <LoaderCircle className="w-5 h-5 animate-spin" />
            ) : (
              'Sign in'
            )}
          </Button>
          <button
            type="button"
            className="w-full text-sm text-muted-foreground hover:text-white transition-colors"
            onClick={() => {
              setPhase('identifier');
              setCode('');
              setError(null);
            }}
          >
            Use a different email or phone
          </button>
        </form>
      )}
    </motion.div>
  );
}

/* ---------------------------------- Photos --------------------------------- */

/** Fetches one owned damage photo (with the portal token header) and renders it. */
function PortalPhoto({
  path,
  token,
  onClick,
  className,
}: {
  path: string;
  token: string;
  onClick?: () => void;
  className?: string;
}) {
  const objectPath = path.replace(/^\/objects\//, '');
  const photo = useGetPortalPhoto(objectPath, {
    request: { headers: { 'x-portal-token': token } },
  });
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!photo.data) return;
    const objectUrl = URL.createObjectURL(photo.data);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [photo.data]);

  if (photo.isError) return null;
  if (!url) {
    return (
      <div
        className={`bg-white/5 animate-pulse rounded-xl ${className ?? ''}`}
        data-testid={`photo-loading-${objectPath}`}
      />
    );
  }
  return (
    <img
      src={url}
      alt="Damage photo you submitted"
      className={`object-cover rounded-xl ${className ?? ''} ${onClick ? 'cursor-pointer hover:opacity-80 transition-opacity' : ''}`}
      onClick={onClick}
      data-testid={`img-claim-photo-${objectPath}`}
    />
  );
}

function PhotoGallery({
  claimId,
  photos,
  token,
}: {
  claimId: string;
  photos: string[];
  token: string;
}) {
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const addPhotos = useAddPortalClaimPhotos({
    request: { headers: { 'x-portal-token': token } },
  });

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList?.length || uploading) return;
    setUploadError(null);
    setAdded(false);

    const files = Array.from(fileList);
    const errors: string[] = [];
    const accepted: File[] = [];
    for (const file of files) {
      if (!ALLOWED_PHOTO_TYPES.includes(file.type)) {
        errors.push(
          `${file.name}: only JPEG, PNG, WebP, or HEIC images are accepted.`,
        );
      } else if (file.size > MAX_PHOTO_BYTES) {
        errors.push(`${file.name}: larger than the 10MB limit.`);
      } else {
        accepted.push(file);
      }
    }
    if (accepted.length > MAX_PHOTOS_PER_BATCH) {
      errors.push(`You can add up to ${MAX_PHOTOS_PER_BATCH} photos at a time.`);
      accepted.splice(MAX_PHOTOS_PER_BATCH);
    }
    if (errors.length) setUploadError(errors.join(' '));
    if (!accepted.length) return;

    setUploading(true);
    try {
      const objectPaths = await Promise.all(
        accepted.map(async (file) => {
          const { uploadURL, objectPath } = await requestPublicUploadUrl({
            name: file.name,
            size: file.size,
            contentType: file.type as never,
          });
          const putRes = await fetch(uploadURL, {
            method: 'PUT',
            headers: { 'Content-Type': file.type },
            body: file,
          });
          if (!putRes.ok) throw new Error(`Upload failed (${putRes.status})`);
          return objectPath;
        }),
      );
      await addPhotos.mutateAsync({
        id: claimId,
        data: { photoPaths: objectPaths },
      });
      await queryClient.invalidateQueries({
        queryKey: getGetPortalOverviewQueryKey(),
      });
      setAdded(true);
      setTimeout(() => setAdded(false), 4000);
    } catch (err) {
      setUploadError(apiError(err));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="p-8 md:p-10 border-b border-white/5">
      <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-4 flex items-center gap-2">
        <Camera className="w-4 h-4 text-primary" /> Your damage photos
      </h3>
      <p className="text-sm text-muted-foreground mb-4">
        {photos.length > 0
          ? 'The photos you submitted — our team uses these to prepare for your inspection. Damage changed? Add new photos any time.'
          : 'No photos yet. If you have pictures of the damage, adding them helps our team prepare for your inspection.'}
      </p>
      {photos.length > 0 && (
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-3 mb-4">
          {photos.map((p) => (
            <PortalPhoto
              key={p}
              path={p}
              token={token}
              onClick={() => setOpenPath(p)}
              className="aspect-square w-full"
            />
          ))}
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept={ALLOWED_PHOTO_TYPES.join(',')}
        multiple
        className="hidden"
        onChange={(e) => {
          void handleFiles(e.target.files);
          e.target.value = '';
        }}
        data-testid={`input-add-photos-${claimId}`}
      />
      {uploadError && (
        <p className="text-sm text-red-400 mb-3">{uploadError}</p>
      )}
      <div className="flex items-center gap-4">
        <Button
          variant="outline"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          data-testid={`button-add-photos-${claimId}`}
        >
          {uploading ? (
            <>
              <LoaderCircle className="w-4 h-4 mr-2 animate-spin" /> Uploading…
            </>
          ) : (
            <>
              <ImagePlus className="w-4 h-4 mr-2" /> Add photos
            </>
          )}
        </Button>
        <AnimatePresence>
          {added && (
            <motion.span
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="text-sm text-green-400 flex items-center gap-1"
              data-testid={`text-photos-added-${claimId}`}
            >
              <Check className="w-4 h-4" /> Photos added — the team can see
              them now.
            </motion.span>
          )}
        </AnimatePresence>
      </div>
      <AnimatePresence>
        {openPath && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={() => setOpenPath(null)}
            data-testid="overlay-photo-lightbox"
          >
            <div className="max-w-3xl max-h-[85vh] w-full flex items-center justify-center">
              <PortalPhoto
                path={openPath}
                token={token}
                className="max-h-[85vh] w-auto max-w-full"
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* --------------------------------- Claims --------------------------------- */

function ClaimCard({ claim, token }: { claim: PortalClaim; token: string }) {
  const [message, setMessage] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const sendMessage = useSendPortalMessage({
    request: { headers: { 'x-portal-token': token } },
  });
  const conversation = useGetPortalConversation(claim.id, {
    request: { headers: { 'x-portal-token': token } },
  });

  const speech = useSpeechOutput();
  const voiceInput = useSpeechInput((transcript) => {
    setMessage((prev) => (prev ? `${prev} ${transcript}` : transcript));
  });

  const messages = conversation.data?.messages ?? [];
  const statusUpdates = claim.updates.filter(
    (u) => u.type !== 'portal_message' && u.type !== 'team_message',
  );

  const currentStep = claim.steps.find((s) => s.state === 'current');
  const upcoming = claim.appointments.filter(
    (a) => new Date(a.scheduledStart).getTime() > Date.now() - 60 * 60 * 1000,
  );

  const statusTexts = (() => {
    const texts: string[] = [];
    texts.push(
      claim.closed
        ? 'This claim is closed.'
        : `Current status: ${currentStep?.label ?? 'Complete'}.`,
    );
    if (!claim.closed && currentStep?.description) texts.push(currentStep.description);
    const updates = statusUpdates.slice(0, 6);
    if (updates.length > 0) {
      texts.push('Recent updates:');
      for (const u of updates) {
        texts.push(`${dateFmt.format(new Date(u.occurredAt))}: ${u.title}.`);
      }
    }
    return texts;
  })();

  const toggleReadAloud = () => {
    const next = !speech.enabled;
    speech.setEnabled(next);
    if (next) {
      // Read the current status and updates as soon as it's switched on.
      speech.speak(statusTexts);
    }
  };

  const handleSend = () => {
    setError(null);
    sendMessage.mutate(
      { id: claim.id, data: { content: message.trim() } },
      {
        onSuccess: () => {
          setSent(true);
          setMessage('');
          setTimeout(() => setSent(false), 4000);
          void queryClient.invalidateQueries({
            queryKey: getGetPortalConversationQueryKey(claim.id),
          });
        },
        onError: (err) => setError(apiError(err)),
      },
    );
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-card rounded-3xl border border-card-border shadow-xl overflow-hidden"
      data-testid={`card-claim-${claim.id}`}
    >
      <div className="p-8 md:p-10 border-b border-white/5">
        <div className="flex flex-wrap items-start justify-between gap-4 mb-2">
          <div>
            <div className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-1">
              Claim started {dateFmt.format(new Date(claim.createdAt))}
            </div>
            <h2 className="text-2xl font-display font-bold">
              {claim.closed
                ? 'Claim closed'
                : (currentStep?.label ?? 'Complete')}
            </h2>
          </div>
          {claim.property && (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <MapPin className="w-4 h-4 text-primary" />
              {claim.property.addressLine1}, {claim.property.city},{' '}
              {claim.property.state} {claim.property.postalCode}
            </div>
          )}
        </div>
        {speech.supported && (
          <button
            type="button"
            role="switch"
            aria-checked={speech.enabled}
            onClick={toggleReadAloud}
            className={`mb-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-full border text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-primary ${
              speech.enabled
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-white/10 bg-white/5 text-muted-foreground hover:text-foreground'
            }`}
            data-testid={`button-read-aloud-${claim.id}`}
          >
            {speech.enabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
            Read updates aloud: {speech.enabled ? 'on' : 'off'}
          </button>
        )}
        {claim.closed ? (
          <p className="text-muted-foreground">
            This claim is no longer active. If that's unexpected, send us a
            message below and we'll take a look.
          </p>
        ) : (
          currentStep && (
            <p className="text-muted-foreground">{currentStep.description}</p>
          )
        )}
      </div>

      {/* Timeline */}
      <div className="p-8 md:p-10 border-b border-white/5">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-6">
          Your journey
        </h3>
        <ol className="space-y-0">
          {claim.steps.map((step, i) => (
            <li key={step.key} className="flex gap-4">
              <div className="flex flex-col items-center">
                {step.state === 'complete' ? (
                  <div className="w-7 h-7 rounded-full bg-green-500/15 flex items-center justify-center shrink-0">
                    <Check className="w-4 h-4 text-green-400" />
                  </div>
                ) : step.state === 'current' ? (
                  <div className="w-7 h-7 rounded-full bg-primary/20 ring-2 ring-primary flex items-center justify-center shrink-0">
                    <div className="w-2.5 h-2.5 rounded-full bg-primary animate-pulse" />
                  </div>
                ) : (
                  <Circle className="w-7 h-7 text-white/10 shrink-0" />
                )}
                {i < claim.steps.length - 1 && (
                  <div
                    className={`w-px flex-1 min-h-6 ${step.state === 'complete' ? 'bg-green-500/30' : 'bg-white/10'}`}
                  />
                )}
              </div>
              <div className="pb-6">
                <div
                  className={`font-medium ${
                    step.state === 'current'
                      ? 'text-primary'
                      : step.state === 'complete'
                        ? 'text-white'
                        : 'text-muted-foreground'
                  }`}
                >
                  {step.label}
                </div>
                {step.state === 'current' && (
                  <p className="text-sm text-muted-foreground mt-1">
                    {step.description}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      </div>

      {/* Damage photos */}
      <PhotoGallery claimId={claim.id} photos={claim.photos} token={token} />

      {/* Appointments */}
      <div className="p-8 md:p-10 border-b border-white/5">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-4">
          Upcoming appointments
        </h3>
        {upcoming.length === 0 ? (
          <p className="text-muted-foreground">
            Nothing scheduled yet — we'll let you know as soon as your next
            visit is on the calendar.
          </p>
        ) : (
          <ul className="space-y-3">
            {upcoming.map((a) => (
              <li
                key={a.id}
                className="flex items-center gap-4 bg-background/50 rounded-2xl border border-white/5 p-4"
                data-testid={`row-appointment-${a.id}`}
              >
                <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                  <CalendarClock className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <div className="font-medium">
                    {APPOINTMENT_LABELS[a.type] ?? 'Appointment'}
                    {a.status === 'confirmed' && (
                      <span className="ml-2 text-xs text-green-400">
                        Confirmed
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {dateFmt.format(new Date(a.scheduledStart))} ·{' '}
                    {timeFmt.format(new Date(a.scheduledStart))}
                    {a.scheduledEnd &&
                      ` – ${timeFmt.format(new Date(a.scheduledEnd))}`}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Updates — status-type only; messages live in the conversation below */}
      {statusUpdates.length > 0 && (
        <div className="p-8 md:p-10 border-b border-white/5">
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-4">
            Recent updates
          </h3>
          <ul className="space-y-4">
            {statusUpdates.slice(0, 6).map((u) => (
              <li key={u.id} className="flex gap-3">
                <CheckCircle2 className="w-4 h-4 text-primary shrink-0 mt-1" />
                <div>
                  <div className="text-sm font-medium">{u.title}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {dateFmt.format(new Date(u.occurredAt))}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Conversation + message the team */}
      <div className="p-8 md:p-10">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-4 flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-primary" /> Your conversation
        </h3>
        {conversation.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-6">
            <LoaderCircle className="w-4 h-4 animate-spin" /> Loading messages…
          </div>
        ) : messages.length === 0 ? (
          <p className="text-muted-foreground mb-6">
            No messages yet — send us a note below and we'll reply right here.
          </p>
        ) : (
          <ul
            className="space-y-3 mb-6 max-h-96 overflow-y-auto pr-1"
            data-testid={`list-conversation-${claim.id}`}
          >
            {messages.map((m) => {
              const isTeam = m.sender === 'team';
              return (
                <li
                  key={m.id}
                  className={`flex ${isTeam ? 'justify-start' : 'justify-end'}`}
                  data-testid={`row-conversation-message-${m.id}`}
                >
                  <div
                    className={`max-w-[85%] rounded-2xl px-4 py-3 border ${
                      isTeam
                        ? 'bg-primary/10 border-primary/20'
                        : 'bg-white/5 border-white/10'
                    }`}
                  >
                    <div className="text-xs font-medium text-muted-foreground mb-1">
                      {isTeam ? 'Your roofing team' : 'You'} ·{' '}
                      {dateFmt.format(new Date(m.occurredAt))}{' '}
                      {timeFmt.format(new Date(m.occurredAt))}
                    </div>
                    <p className="text-sm whitespace-pre-wrap">{m.body}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <Textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Questions about your inspection, schedule, or anything else — we read every message."
          className="mb-3 min-h-24"
          maxLength={2000}
          data-testid={`input-message-${claim.id}`}
        />
        {voiceInput.error && (
          <p role="status" className="text-sm text-muted-foreground mb-3">
            {voiceInput.error}
          </p>
        )}
        {error && <p className="text-sm text-red-400 mb-3">{error}</p>}
        <div className="flex items-center gap-4">
          {voiceInput.supported && (
            <Button
              type="button"
              variant="outline"
              onClick={voiceInput.toggle}
              disabled={sendMessage.isPending}
              aria-label={voiceInput.listening ? 'Stop listening' : 'Speak your message'}
              aria-pressed={voiceInput.listening}
              className={
                voiceInput.listening
                  ? 'border-destructive/50 bg-destructive/15 text-red-300 motion-safe:animate-pulse'
                  : undefined
              }
              data-testid={`button-voice-message-${claim.id}`}
            >
              {voiceInput.listening ? (
                <MicOff className="w-4 h-4" />
              ) : (
                <Mic className="w-4 h-4" />
              )}
            </Button>
          )}
          <Button
            onClick={handleSend}
            disabled={sendMessage.isPending || message.trim().length === 0}
            data-testid={`button-send-message-${claim.id}`}
          >
            {sendMessage.isPending ? (
              <LoaderCircle className="w-4 h-4 animate-spin" />
            ) : (
              'Send message'
            )}
          </Button>
          <AnimatePresence>
            {sent && (
              <motion.span
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="text-sm text-green-400 flex items-center gap-1"
              >
                <Check className="w-4 h-4" /> Sent — the team will follow up.
              </motion.span>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
}

/* -------------------------------- Dashboard ------------------------------- */

function Dashboard({ token, onLogout }: { token: string; onLogout: () => void }) {
  const queryClient = useQueryClient();
  const logout = useLogoutPortalSession({
    request: { headers: { 'x-portal-token': token } },
  });
  const overview = useGetPortalOverview({
    request: { headers: { 'x-portal-token': token } },
  });

  if (overview.isLoading) {
    return (
      <div className="flex justify-center py-24">
        <LoaderCircle className="w-8 h-8 text-primary animate-spin" />
      </div>
    );
  }

  if (overview.isError) {
    // Expired/invalid session → back to login.
    window.localStorage.removeItem(TOKEN_KEY);
    onLogout();
    return null;
  }

  const data = overview.data!;

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl md:text-4xl font-display font-bold">
            {data.contact
              ? `Welcome back, ${data.contact.firstName}`
              : 'Welcome back'}
          </h1>
          <p className="text-muted-foreground mt-1">
            Everything about your roof claim, in one place.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            logout.mutate();
            window.localStorage.removeItem(TOKEN_KEY);
            queryClient.clear();
            onLogout();
          }}
          data-testid="button-portal-logout"
        >
          <LogOut className="w-4 h-4 mr-2" /> Sign out
        </Button>
      </div>

      {data.claims.length === 0 ? (
        <div className="bg-card p-10 rounded-3xl border border-card-border text-center">
          <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
            <Home className="w-7 h-7 text-primary" />
          </div>
          <h2 className="text-xl font-display font-bold mb-2">
            No claims yet
          </h2>
          <p className="text-muted-foreground mb-6">
            When you request a free roof assessment, your claim will show up
            here automatically.
          </p>
          <Button onClick={() => (window.location.href = '/assessment')}>
            Start a free assessment
          </Button>
        </div>
      ) : (
        data.claims.map((claim) => (
          <ClaimCard key={claim.id} claim={claim} token={token} />
        ))
      )}
    </div>
  );
}

/* ---------------------------------- Page ---------------------------------- */

export default function PortalPage() {
  const [token, setToken] = useState<string | null>(() => getToken());

  return (
    <div className="min-h-screen py-16 md:py-24 px-4">
      <div className="container mx-auto">
        {token ? (
          <Dashboard token={token} onLogout={() => setToken(null)} />
        ) : (
          <LoginCard onAuthed={setToken} />
        )}
      </div>
    </div>
  );
}
