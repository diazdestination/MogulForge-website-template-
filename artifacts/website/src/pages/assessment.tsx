import { useState, useEffect, useRef, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { motion, AnimatePresence } from 'framer-motion';
import { useSubmitAssessment, requestPublicUploadUrl, AssessmentSubmissionIntent, Urgency, AssessmentResult } from '@workspace/api-client-react';
import { useAnalytics } from '@/lib/analytics';
import { Seo, breadcrumbJsonLd } from '@/lib/seo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { ArrowLeft, ArrowRight, ShieldCheck, CheckCircle2, CloudLightning, Droplets, Home, AlertCircle, Loader2, Check, ShieldAlert, Camera, X, ImageIcon } from 'lucide-react';
import { Link, useLocation } from 'wouter';

const MAX_PHOTOS = 10;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // 10MB — matches the API limit
const ALLOWED_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

interface UploadedPhoto {
  id: string;
  name: string;
  previewUrl: string;
  objectPath?: string;
  status: 'uploading' | 'done' | 'error';
}

const assessmentSchema = z.object({
  intent: z.enum(["active-leak", "storm", "replacement", "water-damage", "emergency", "general"]),
  urgency: z.enum(["low", "normal", "high", "emergency"]),
  addressLine1: z.string().min(1, "Street address is required"),
  addressLine2: z.string().optional(),
  city: z.string().min(1, "City is required"),
  state: z.string().min(2, "State is required"),
  postalCode: z.string().min(3, "ZIP code is required"),
  description: z.string().optional(),
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().optional(),
  email: z.string().email("Invalid email").optional().or(z.literal("")),
  phone: z.string().min(7, "Valid phone required"),
  consentGranted: z.boolean().refine(v => v === true, "You must consent to continue")
});

type AssessmentFormValues = z.infer<typeof assessmentSchema>;

export default function AssessmentPage() {
  const { track } = useAnalytics();
  const submitAssessment = useSubmitAssessment();
  
  const [step, setStep] = useState(1);
  const [result, setResult] = useState<AssessmentResult | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [photos, setPhotos] = useState<UploadedPhoto[]>([]);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isUploadingPhotos = photos.some(p => p.status === 'uploading');

  const handlePhotoSelect = useCallback(async (fileList: FileList | null) => {
    if (!fileList?.length) return;
    setPhotoError(null);

    const files = Array.from(fileList);
    const errors: string[] = [];
    const accepted: File[] = [];

    for (const file of files) {
      if (!ALLOWED_PHOTO_TYPES.includes(file.type)) {
        errors.push(`${file.name}: only JPEG, PNG, WebP, or HEIC images are accepted.`);
      } else if (file.size > MAX_PHOTO_BYTES) {
        errors.push(`${file.name}: larger than the 10MB limit.`);
      } else {
        accepted.push(file);
      }
    }

    const room = MAX_PHOTOS - photos.length;
    if (accepted.length > room) {
      errors.push(`You can attach up to ${MAX_PHOTOS} photos.`);
      accepted.splice(Math.max(room, 0));
    }
    if (errors.length) setPhotoError(errors.join(' '));
    if (!accepted.length) return;

    const entries: { entry: UploadedPhoto; file: File }[] = accepted.map(file => ({
      file,
      entry: {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: file.name,
        previewUrl: URL.createObjectURL(file),
        status: 'uploading' as const,
      },
    }));
    setPhotos(current => [...current, ...entries.map(e => e.entry)]);

    await Promise.all(entries.map(async ({ entry, file }) => {
      try {
        const { uploadURL, objectPath } = await requestPublicUploadUrl({
          name: file.name,
          size: file.size,
          contentType: file.type as (typeof ALLOWED_PHOTO_TYPES)[number] as any,
        });
        const putRes = await fetch(uploadURL, {
          method: 'PUT',
          headers: { 'Content-Type': file.type },
          body: file,
        });
        if (!putRes.ok) throw new Error(`Upload failed (${putRes.status})`);
        setPhotos(current => current.map(p => p.id === entry.id ? { ...p, objectPath, status: 'done' } : p));
        track('assessment_photo_uploaded');
      } catch {
        setPhotos(current => current.map(p => p.id === entry.id ? { ...p, status: 'error' } : p));
        setPhotoError('One or more photos failed to upload. Remove them and try again.');
      }
    }));
  }, [track, photos.length]);

  const removePhoto = (id: string) => {
    setPhotos(current => {
      const target = current.find(p => p.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return current.filter(p => p.id !== id);
    });
  };

  const form = useForm<AssessmentFormValues>({
    resolver: zodResolver(assessmentSchema),
    defaultValues: {
      intent: 'general',
      urgency: 'normal',
      addressLine1: (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('painless_storm_address')) || '',
      addressLine2: '',
      city: '',
      state: '',
      postalCode: '',
      description: '',
      firstName: '',
      lastName: '',
      email: '',
      phone: '',
      consentGranted: false,
    },
    mode: 'onChange',
  });

  // Initialize intent from URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const intentParam = params.get('intent');
    if (intentParam && ['active-leak', 'storm', 'replacement', 'water-damage', 'emergency', 'general'].includes(intentParam)) {
      form.setValue('intent', intentParam as any);
      if (intentParam === 'emergency' || intentParam === 'active-leak' || intentParam === 'water-damage') {
        form.setValue('urgency', 'emergency');
      }
    }
    track('assessment_started');
  }, [form, track]);

  const validateStep = async () => {
    let isValid = false;
    if (step === 1) {
      isValid = await form.trigger(['intent', 'urgency']);
    } else if (step === 2) {
      isValid = await form.trigger(['addressLine1', 'city', 'state', 'postalCode']);
    } else if (step === 3) {
      isValid = await form.trigger(['description']);
    }
    return isValid;
  };

  const nextStep = async () => {
    if (await validateStep()) {
      track('assessment_step_completed', { step, stepName: `step_${step}` });
      setStep(s => s + 1);
    }
  };

  const prevStep = () => {
    setStep(s => Math.max(1, s - 1));
  };

  const onSubmit = (data: AssessmentFormValues) => {
    setSubmitError(null);
    track('assessment_submitted', { intent: data.intent });
    
    submitAssessment.mutate({
      data: {
        firstName: data.firstName,
        lastName: data.lastName,
        email: data.email,
        phone: data.phone,
        addressLine1: data.addressLine1,
        addressLine2: data.addressLine2,
        city: data.city,
        state: data.state,
        postalCode: data.postalCode,
        intent: data.intent as AssessmentSubmissionIntent,
        urgency: data.urgency as Urgency,
        description: data.description,
        source: 'website',
        photoPaths: photos.filter(p => p.status === 'done' && p.objectPath).map(p => p.objectPath!),
        consent: {
          smsGranted: data.consentGranted,
          emailGranted: data.consentGranted,
          disclosureVersion: "2026-08-01.v1"
        }
      }
    }, {
      onSuccess: (res) => {
        track('assessment_result_viewed', { score: res.score, leadId: res.leadId });
        setResult(res);
        setStep(5); // Result step
      },
      onError: (err: any) => {
        if (err?.status === 429) {
          setSubmitError('Please wait a moment and try again.');
        } else {
          setSubmitError('An unexpected error occurred. Please call us directly.');
        }
      }
    });
  };

  const currentIntent = form.watch('intent');

  return (
    <div className="flex-1 bg-background flex flex-col min-h-[calc(100vh-64px)]">
      <Seo
        title="Free Roof Assessment — Get Guidance in Minutes"
        description="Tell us what happened, and get an honest urgency read plus next steps for your roof — free, online, no obligation. Serving Canton, GA and North Georgia 24/7."
        path="/assessment"
        jsonLd={breadcrumbJsonLd([{ name: 'Home', path: '/' }, { name: 'Roof Assessment', path: '/assessment' }])}
      />
      {step < 5 && (
        <div className="w-full bg-background border-b border-white/5 sticky top-20 z-40">
          <div className="container mx-auto px-4 h-2 max-w-3xl">
            <div className="h-full bg-white/5 rounded-full overflow-hidden">
              <motion.div 
                className="h-full bg-primary"
                initial={{ width: 0 }}
                animate={{ width: `${(step / 4) * 100}%` }}
                transition={{ duration: 0.3 }}
              />
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 container mx-auto px-4 py-12 max-w-3xl flex flex-col justify-center">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="w-full">
            
            <AnimatePresence mode="wait">
              {step === 1 && (
                <motion.div
                  key="step1"
                  initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}
                  className="space-y-8"
                >
                  <div className="text-center mb-10">
                    <h2 className="text-3xl md:text-5xl font-display font-bold mb-4">What's going on?</h2>
                    <p className="text-muted-foreground text-lg">Help us understand the situation so we can prioritize correctly.</p>
                  </div>

                  <FormField
                    control={form.control}
                    name="intent"
                    render={({ field }) => (
                      <FormItem>
                        <div className="grid sm:grid-cols-2 gap-4">
                          <IntentCard 
                            selected={field.value === 'active-leak'}
                            onClick={() => { field.onChange('active-leak'); form.setValue('urgency', 'emergency'); }}
                            icon={<ShieldAlert className="w-6 h-6 text-orange-400" />}
                            title="Active Leak"
                            desc="Water is actively coming in."
                          />
                          <IntentCard 
                            selected={field.value === 'storm'}
                            onClick={() => { field.onChange('storm'); form.setValue('urgency', 'normal'); }}
                            icon={<CloudLightning className="w-6 h-6 text-primary" />}
                            title="Storm Damage"
                            desc="Wind or hail hit recently."
                          />
                          <IntentCard 
                            selected={field.value === 'water-damage'}
                            onClick={() => { field.onChange('water-damage'); form.setValue('urgency', 'emergency'); }}
                            icon={<Droplets className="w-6 h-6 text-cyan-400" />}
                            title="Water Damage"
                            desc="Signs of intrusion inside."
                          />
                          <IntentCard 
                            selected={field.value === 'replacement'}
                            onClick={() => { field.onChange('replacement'); form.setValue('urgency', 'normal'); }}
                            icon={<Home className="w-6 h-6 text-indigo-400" />}
                            title="Roof Replacement"
                            desc="Old roof needs replacing."
                          />
                        </div>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <div className="flex justify-end pt-8 border-t border-white/5">
                    <Button type="button" size="lg" onClick={nextStep} className="h-14 px-8 text-lg rounded-xl">
                      Next Step <ArrowRight className="w-5 h-5 ml-2" />
                    </Button>
                  </div>
                </motion.div>
              )}

              {step === 2 && (
                <motion.div
                  key="step2"
                  initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}
                  className="space-y-8"
                >
                  <div className="text-center mb-10">
                    <h2 className="text-3xl md:text-4xl font-display font-bold mb-4">Where is the property?</h2>
                    <p className="text-muted-foreground">We need the address to run digital property analytics.</p>
                  </div>

                  <div className="space-y-5 bg-card/50 p-8 rounded-3xl border border-card-border backdrop-blur-sm">
                    <FormField control={form.control} name="addressLine1" render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-muted-foreground">Street Address</FormLabel>
                        <FormControl><Input placeholder="123 Main St" className="h-14 text-lg bg-background/50" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={form.control} name="addressLine2" render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-muted-foreground">Apt, Suite, etc. (Optional)</FormLabel>
                        <FormControl><Input className="h-14 text-lg bg-background/50" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-5">
                      <FormField control={form.control} name="city" render={({ field }) => (
                        <FormItem className="col-span-2">
                          <FormLabel className="text-muted-foreground">City</FormLabel>
                          <FormControl><Input className="h-14 text-lg bg-background/50" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={form.control} name="state" render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-muted-foreground">State</FormLabel>
                          <FormControl><Input placeholder="GA" className="h-14 text-lg bg-background/50" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={form.control} name="postalCode" render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-muted-foreground">ZIP</FormLabel>
                          <FormControl><Input placeholder="30301" className="h-14 text-lg bg-background/50" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                  </div>

                  <div className="flex justify-between pt-8 border-t border-white/5">
                    <Button type="button" variant="ghost" size="lg" onClick={prevStep} className="h-14 text-muted-foreground hover:text-white">
                      <ArrowLeft className="w-5 h-5 mr-2" /> Back
                    </Button>
                    <Button type="button" size="lg" onClick={nextStep} className="h-14 px-8 text-lg rounded-xl">
                      Next Step <ArrowRight className="w-5 h-5 ml-2" />
                    </Button>
                  </div>
                </motion.div>
              )}

              {step === 3 && (
                <motion.div
                  key="step3"
                  initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}
                  className="space-y-8"
                >
                  <div className="text-center mb-10">
                    <h2 className="text-3xl md:text-4xl font-display font-bold mb-4">Provide context</h2>
                    <p className="text-muted-foreground">Describe what you're seeing, and attach photos of the damage if you have them.</p>
                  </div>

                  <FormField
                    control={form.control}
                    name="description"
                    render={({ field }) => (
                      <FormItem>
                        <FormControl>
                          <Textarea 
                            placeholder="e.g. There is a water stain on the living room ceiling that started during last night's storm..." 
                            className="min-h-[200px] text-lg p-6 rounded-3xl bg-card/50 border border-card-border backdrop-blur-sm resize-none"
                            {...field} 
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <div className="space-y-4">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
                      multiple
                      className="hidden"
                      onChange={(e) => { handlePhotoSelect(e.target.files); e.target.value = ''; }}
                    />
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={photos.length >= MAX_PHOTOS}
                      className="w-full rounded-3xl border-2 border-dashed border-card-border bg-card/30 hover:border-primary/40 hover:bg-card/50 transition-colors p-8 flex flex-col items-center gap-3 text-center disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <div className="w-12 h-12 rounded-xl bg-background/50 flex items-center justify-center">
                        <Camera className="w-6 h-6 text-primary" />
                      </div>
                      <div>
                        <div className="font-semibold">Add damage photos <span className="text-muted-foreground font-normal">(optional)</span></div>
                        <div className="text-sm text-muted-foreground mt-1">JPEG, PNG, WebP or HEIC — up to {MAX_PHOTOS} photos, 10MB each. Photos help us triage before the inspection.</div>
                      </div>
                    </button>

                    {photoError && (
                      <div className="p-4 rounded-xl bg-destructive/10 border border-destructive/20 text-red-400 text-sm flex items-center gap-3">
                        <AlertCircle className="w-5 h-5 shrink-0" />
                        {photoError}
                      </div>
                    )}

                    {photos.length > 0 && (
                      <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
                        {photos.map(photo => (
                          <div key={photo.id} className={`relative aspect-square rounded-xl overflow-hidden border ${photo.status === 'error' ? 'border-destructive' : 'border-card-border'}`}>
                            <img src={photo.previewUrl} alt={photo.name} className="w-full h-full object-cover" />
                            {photo.status === 'uploading' && (
                              <div className="absolute inset-0 bg-background/60 flex items-center justify-center">
                                <Loader2 className="w-5 h-5 animate-spin text-primary" />
                              </div>
                            )}
                            {photo.status === 'error' && (
                              <div className="absolute inset-0 bg-destructive/40 flex items-center justify-center">
                                <AlertCircle className="w-5 h-5 text-white" />
                              </div>
                            )}
                            {photo.status === 'done' && (
                              <div className="absolute bottom-1 left-1 w-5 h-5 rounded-full bg-green-500/90 flex items-center justify-center">
                                <Check className="w-3 h-3 text-white" />
                              </div>
                            )}
                            <button
                              type="button"
                              aria-label={`Remove ${photo.name}`}
                              onClick={() => removePhoto(photo.id)}
                              className="absolute top-1 right-1 w-6 h-6 rounded-full bg-background/80 hover:bg-background flex items-center justify-center"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="flex justify-between pt-8 border-t border-white/5">
                    <Button type="button" variant="ghost" size="lg" onClick={prevStep} className="h-14 text-muted-foreground hover:text-white">
                      <ArrowLeft className="w-5 h-5 mr-2" /> Back
                    </Button>
                    <Button type="button" size="lg" onClick={nextStep} disabled={isUploadingPhotos} className="h-14 px-8 text-lg rounded-xl">
                      {isUploadingPhotos ? <><Loader2 className="w-5 h-5 mr-2 animate-spin" /> Uploading…</> : <>Next Step <ArrowRight className="w-5 h-5 ml-2" /></>}
                    </Button>
                  </div>
                </motion.div>
              )}

              {step === 4 && (
                <motion.div
                  key="step4"
                  initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}
                  className="space-y-8"
                >
                  <div className="text-center mb-10">
                    <h2 className="text-3xl md:text-4xl font-display font-bold mb-4">Final step</h2>
                    <p className="text-muted-foreground">Where should we send your digital assessment?</p>
                  </div>

                  <div className="space-y-5 bg-card/50 p-8 rounded-3xl border border-card-border backdrop-blur-sm">
                    <div className="grid sm:grid-cols-2 gap-5">
                      <FormField control={form.control} name="firstName" render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-muted-foreground">First Name</FormLabel>
                          <FormControl><Input className="h-14 text-lg bg-background/50" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={form.control} name="lastName" render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-muted-foreground">Last Name</FormLabel>
                          <FormControl><Input className="h-14 text-lg bg-background/50" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                    <div className="grid sm:grid-cols-2 gap-5">
                      <FormField control={form.control} name="phone" render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-muted-foreground">Phone Number</FormLabel>
                          <FormControl><Input type="tel" className="h-14 text-lg bg-background/50" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={form.control} name="email" render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-muted-foreground">Email Address</FormLabel>
                          <FormControl><Input type="email" className="h-14 text-lg bg-background/50" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                  </div>

                  <FormField
                    control={form.control}
                    name="consentGranted"
                    render={({ field }) => (
                      <FormItem className="flex flex-row items-start space-x-4 space-y-0 bg-background/50 p-6 rounded-2xl border border-white/5">
                        <FormControl>
                          <Checkbox 
                            checked={field.value} 
                            onCheckedChange={(checked) => {
                              field.onChange(checked);
                              if (checked) track('assessment_consent_granted');
                            }} 
                            className="mt-1 border-white/20 data-[state=checked]:bg-primary"
                          />
                        </FormControl>
                        <div className="space-y-2 leading-none">
                          <FormLabel className="text-sm font-normal text-muted-foreground leading-relaxed cursor-pointer">
                            I agree to receive updates about my roof assessment by text message and email from Painless Roofing & Water Restoration. Message and data rates may apply. Reply STOP to opt out at any time. Consent is not a condition of purchase.
                          </FormLabel>
                          <FormMessage />
                        </div>
                      </FormItem>
                    )}
                  />

                  {submitError && (
                    <div className="p-4 rounded-xl bg-destructive/10 border border-destructive/20 text-red-400 text-sm flex items-center gap-3">
                      <AlertCircle className="w-5 h-5 shrink-0" />
                      {submitError}
                    </div>
                  )}

                  <div className="flex justify-between pt-8 border-t border-white/5">
                    <Button type="button" variant="ghost" size="lg" onClick={prevStep} disabled={submitAssessment.isPending} className="h-14 text-muted-foreground hover:text-white">
                      <ArrowLeft className="w-5 h-5 mr-2" /> Back
                    </Button>
                    <Button type="submit" size="lg" disabled={submitAssessment.isPending || !form.watch('consentGranted')} className="h-14 px-8 text-lg rounded-xl shadow-[0_0_30px_rgba(56,189,248,0.2)]">
                      {submitAssessment.isPending ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Submit Assessment'}
                    </Button>
                  </div>
                </motion.div>
              )}

              {step === 5 && result && (
                <motion.div
                  key="step5"
                  initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
                  className="bg-card p-10 md:p-12 rounded-3xl border border-card-border shadow-2xl text-center"
                >
                  <div className="w-24 h-24 rounded-full bg-green-500/10 flex items-center justify-center mx-auto mb-8">
                    <CheckCircle2 className="w-12 h-12 text-green-400" />
                  </div>
                  <h2 className="text-3xl md:text-4xl font-display font-bold mb-4">Assessment Received</h2>
                  <p className="text-muted-foreground text-lg mb-8">Your digital concierge file has been created. Here is our initial guidance based on your inputs.</p>

                  <div className="text-left bg-background/50 p-8 rounded-2xl border border-white/5 mb-8">
                    <div className="mb-6 pb-6 border-b border-white/5 flex items-start justify-between gap-6">
                      <div>
                        <div className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-2">Priority Level</div>
                        <div className={`text-2xl font-display font-bold ${result.urgency === 'emergency' ? 'text-red-400' : 'text-primary'}`}>
                          {result.urgency.charAt(0).toUpperCase() + result.urgency.slice(1)}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-2">Priority Score</div>
                        <div className="text-2xl font-display font-bold text-primary">{result.score}<span className="text-base text-muted-foreground font-normal"> / 100</span></div>
                      </div>
                    </div>
                    
                    <div className="mb-6">
                      <div className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">Guidance</div>
                      <p className="text-white text-lg leading-relaxed">{result.guidance}</p>
                    </div>

                    {result.scoreReasons.length > 0 && (
                      <div>
                        <div className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">Key Factors Identified</div>
                        <ul className="space-y-2">
                          {result.scoreReasons.map((reason, i) => (
                            <li key={i} className="flex items-start gap-2 text-muted-foreground">
                              <Check className="w-4 h-4 text-primary shrink-0 mt-1" />
                              <span>{reason}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>

                  <p className="text-muted-foreground mb-6">
                    You can follow your claim anytime — from leak to repair — in the{' '}
                    <Link href="/portal" className="text-primary hover:underline">Claim Portal</Link>. Sign in with the email or phone number you just used.
                  </p>
                  <Button onClick={() => window.location.href = '/'} variant="outline" size="lg" className="h-14 px-8 text-lg">
                    Return to Homepage
                  </Button>
                </motion.div>
              )}
            </AnimatePresence>
          </form>
        </Form>
      </div>
    </div>
  );
}

function IntentCard({ icon, title, desc, selected, onClick }: { icon: React.ReactNode, title: string, desc: string, selected: boolean, onClick: () => void }) {
  return (
    <div 
      onClick={onClick}
      className={`cursor-pointer rounded-2xl p-6 border-2 transition-all duration-300 flex flex-col h-full ${
        selected 
          ? 'bg-primary/10 border-primary shadow-[0_0_20px_rgba(56,189,248,0.2)]' 
          : 'bg-card/50 border-card-border hover:border-primary/40 hover:bg-card'
      }`}
    >
      <div className="w-12 h-12 rounded-xl bg-background/50 flex items-center justify-center mb-4">
        {icon}
      </div>
      <h4 className="text-xl font-display font-semibold mb-2">{title}</h4>
      <p className="text-sm text-muted-foreground">{desc}</p>
    </div>
  );
}
