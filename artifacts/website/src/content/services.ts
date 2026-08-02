import type { LucideIcon } from 'lucide-react';
import {
  AlarmClockCheck,
  Building2,
  CloudLightning,
  Droplets,
  FileCheck2,
  Hammer,
  Home,
  Layers,
  PanelsTopLeft,
  Search,
  ShieldAlert,
  Warehouse,
  Wrench,
} from 'lucide-react';

export interface ServiceContent {
  slug: string;
  name: string;
  shortName: string;
  icon: LucideIcon;
  /** One-line card description used in indexes and internal links. */
  teaser: string;
  metaTitle: string;
  metaDescription: string;
  headline: string;
  intro: string;
  /** Homeowner problems this service addresses — unique per service. */
  problems: string[];
  /** How the work proceeds, step by step. */
  process: Array<{ title: string; detail: string }>;
  faqs: Array<{ question: string; answer: string }>;
  relatedSlugs: string[];
  emergency?: boolean;
}

export const SERVICES: ServiceContent[] = [
  {
    slug: 'roof-repair',
    name: 'Roof Repair',
    shortName: 'Repair',
    icon: Wrench,
    teaser: 'Targeted fixes for leaks, missing shingles, flashing failures, and storm-loosened components.',
    metaTitle: 'Roof Repair in Canton & Metro Atlanta, GA',
    metaDescription:
      'Professional roof repair in Canton, GA and metro Atlanta. Leaks, missing shingles, flashing, and ventilation issues fixed with quality materials and honest assessments. Call (404) 444-4476.',
    headline: 'Roof repair that stops the problem, not just the symptom.',
    intro:
      "Most leaks don't start where the water shows up. Our repair work begins with finding the true entry point — failed flashing, cracked pipe boots, nail pops, or shingles aged by Georgia's heat cycles — and fixing it so the same call never has to happen twice.",
    problems: [
      'Water stains spreading on ceilings or walls after rain',
      'Shingles cracked, curled, or missing after wind events',
      'Flashing separating around chimneys, valleys, and skylights',
      'Attic ventilation problems accelerating shingle aging from southern heat',
      'Granule loss collecting in gutters and downspouts',
    ],
    process: [
      { title: 'Trace the leak to its source', detail: 'We inspect the roof surface, penetrations, and attic side to find where water actually enters — not just where it appears.' },
      { title: 'Document and explain', detail: 'You get photos of the damage and a plain-language explanation of what failed and why, before any work is approved.' },
      { title: 'Repair with matched materials', detail: 'Repairs use materials matched to your existing roof so the fix blends in and performs like the rest of the system.' },
      { title: 'Verify and warranty', detail: 'We water-test where practical and stand behind the repair.' },
    ],
    faqs: [
      { question: 'How do I know if I need a repair or a full replacement?', answer: 'Isolated damage on a roof with remaining service life usually calls for repair. Widespread granule loss, repeated leaks, or a roof near the end of its lifespan may make replacement more economical. We give you an honest assessment either way — repair when repair is right.' },
      { question: 'Can you match my existing shingles?', answer: 'In most cases yes. We match manufacturer, profile, and color as closely as available. If your shingle line is discontinued, we show you the closest options before starting.' },
      { question: 'How fast can a leak be repaired?', answer: 'Active leaks are prioritized. We can typically tarp or stabilize quickly, then complete the permanent repair once materials and weather allow.' },
    ],
    relatedSlugs: ['roof-replacement', 'emergency-roofing', 'roof-inspection', 'storm-damage'],
  },
  {
    slug: 'roof-replacement',
    name: 'Roof Replacement',
    shortName: 'Replacement',
    icon: Home,
    teaser: 'Full tear-off and replacement with quality materials, clear communication, and clean job sites.',
    metaTitle: 'Roof Replacement in Canton & North Georgia',
    metaDescription:
      'Full roof replacement in Canton, GA and surrounding areas. Quality architectural shingles, proper ventilation, transparent pricing, and a family-owned crew. Call (404) 444-4476.',
    headline: 'A new roof, without the runaround.',
    intro:
      'A replacement is one of the biggest investments in your home — and one of the easiest to get burned on. We replace roofs the way we would want ours done: full tear-off, deck inspection, correct ventilation, quality underlayment, and a crew that leaves your yard cleaner than they found it.',
    problems: [
      'Roof at or past its expected lifespan (15–25 years for most asphalt shingles in Georgia heat)',
      'Repeated repairs no longer keeping up with leaks',
      'Widespread hail bruising or wind damage across multiple slopes',
      'Sagging decking or soft spots underfoot',
      'Poor attic ventilation cooking shingles from below',
    ],
    process: [
      { title: 'Full inspection and options', detail: 'We assess the deck, ventilation, and flashing — then present material and color options with real pricing, not a single take-it-or-leave-it number.' },
      { title: 'Insurance coordination if applicable', detail: 'If storm damage is involved, we document everything your adjuster needs. We never guarantee claim outcomes — we make sure the damage is properly represented.' },
      { title: 'Tear-off and deck repair', detail: 'Old material comes off completely. Damaged decking is replaced and photographed so you can see what was fixed.' },
      { title: 'Install and final walkthrough', detail: 'New underlayment, ice-and-water barriers where needed, ridge ventilation, and a magnetic sweep of your yard for nails. You walk the job with us before we call it done.' },
    ],
    faqs: [
      { question: 'How long does a roof replacement take?', answer: 'Most residential replacements are completed in one to two days once materials are on site, weather permitting.' },
      { question: 'Will insurance cover my replacement?', answer: 'If the roof was damaged by a covered event like hail or wind, it may. We document damage thoroughly for your claim, but coverage decisions belong to your insurer — anyone who guarantees approval is overpromising.' },
      { question: 'What shingles do you install?', answer: 'We install architectural shingles from major manufacturers, selected for performance in Georgia heat and storm exposure. We walk you through the options and warranties.' },
    ],
    relatedSlugs: ['roof-installation', 'insurance-claims', 'storm-damage', 'metal-roofing'],
  },
  {
    slug: 'roof-installation',
    name: 'Roof Installation',
    shortName: 'Installation',
    icon: Layers,
    teaser: 'New-construction and addition roofing installed right the first time.',
    metaTitle: 'New Roof Installation in Canton & Metro Atlanta',
    metaDescription:
      'New roof installation for new construction and additions in Canton, GA and metro Atlanta. Correct ventilation, quality underlayment, and craftsmanship. Call (404) 444-4476.',
    headline: 'New construction deserves a roof built to outlast the framing warranty.',
    intro:
      "A new roof only gets one chance to be installed right. Ventilation, underlayment, flashing details, and fastening patterns determine whether your roof quietly does its job for decades or starts causing problems in year five. We sweat those details on every installation.",
    problems: [
      'New construction or home additions needing a complete roof system',
      'Garage, shop, or outbuilding roofs',
      'Builder-grade roofs that cut corners on ventilation and flashing',
      'Coordinating roofing with other trades on a construction schedule',
    ],
    process: [
      { title: 'Plan review and system design', detail: 'We review your plans, calculate ventilation requirements, and specify a full roof system — not just shingles.' },
      { title: 'Scheduling around your build', detail: 'We coordinate with your builder or GC so roofing lands at the right point in the schedule.' },
      { title: 'System installation', detail: 'Deck verification, underlayment, ice-and-water protection, drip edge, flashing, field material, and ridge ventilation installed to manufacturer spec.' },
      { title: 'Documentation for warranty', detail: 'You receive the documentation needed to register manufacturer warranties.' },
    ],
    faqs: [
      { question: 'Do you work with builders and general contractors?', answer: 'Yes. We handle roofing scopes for builders, GCs, and homeowners acting as their own GC, and we keep to the schedule we commit to.' },
      { question: 'What is included in a full roof system?', answer: 'Decking verification, underlayment, ice-and-water barriers at vulnerable areas, drip edge, step and counter flashing, field shingles or panels, and balanced intake/exhaust ventilation.' },
      { question: 'Can you install metal instead of shingles?', answer: 'Yes — we install standing-seam and ribbed metal profiles as well as architectural shingles. See our metal roofing page for details.' },
    ],
    relatedSlugs: ['metal-roofing', 'roof-replacement', 'commercial-roofing'],
  },
  {
    slug: 'metal-roofing',
    name: 'Metal Roofing',
    shortName: 'Metal',
    icon: PanelsTopLeft,
    teaser: 'Standing-seam and ribbed metal systems for longevity and storm resistance.',
    metaTitle: 'Metal Roofing Installation & Repair in North Georgia',
    metaDescription:
      'Standing-seam and ribbed metal roofing in Canton, GA and North Georgia. 40+ year lifespans, storm resistance, and energy savings. Installation and repair. Call (404) 444-4476.',
    headline: 'The last roof many homeowners ever buy.',
    intro:
      'Metal roofing costs more up front and earns it back for decades: 40–70 year lifespans, better hail and wind resistance than asphalt, and reflective finishes that fight the Georgia sun instead of absorbing it. We install both standing-seam and exposed-fastener ribbed profiles, and we repair existing metal roofs.',
    problems: [
      'Wanting a roof that outlasts two or three shingle cycles',
      'High cooling bills from heat-absorbing asphalt',
      'Hail-prone areas where impact resistance matters',
      'Existing metal roofs with fastener back-out, oil-canning, or panel damage',
    ],
    process: [
      { title: 'Profile and finish selection', detail: 'Standing-seam for concealed fasteners and clean lines, or ribbed panels for value — we walk through gauge, finish, and color options honestly.' },
      { title: 'Substrate preparation', detail: 'Deck condition, underlayment suited to metal, and thermal movement details are handled before a single panel goes down.' },
      { title: 'Precision installation', detail: 'Panels cut and seamed for your roof, with correct clip spacing and flashing details that accommodate expansion.' },
      { title: 'Final inspection', detail: 'Every seam, penetration, and termination checked before we leave.' },
    ],
    faqs: [
      { question: 'Is a metal roof loud in the rain?', answer: 'Not on a home. Installed over solid decking and underlayment, a metal roof is about as quiet as asphalt shingles. The rain-on-a-tin-barn sound comes from open framing, not modern residential installation.' },
      { question: 'Standing-seam vs. ribbed — which should I pick?', answer: 'Standing-seam hides its fasteners, handles thermal movement best, and lasts longest — at a higher price. Ribbed (exposed-fastener) panels cost less and still outlast asphalt, but fasteners need periodic checks. We price both so you can decide.' },
      { question: 'Can metal be installed over my existing shingles?', answer: 'Sometimes, with appropriate underlayment or furring — but a tear-off lets us verify the deck. We inspect first and tell you which your roof actually needs.' },
    ],
    relatedSlugs: ['roof-installation', 'roof-replacement', 'commercial-roofing'],
  },
  {
    slug: 'commercial-roofing',
    name: 'Commercial Roofing',
    shortName: 'Commercial',
    icon: Building2,
    teaser: 'Low-slope and commercial roof systems, repairs, and maintenance for business properties.',
    metaTitle: 'Commercial Roofing in Canton & Metro Atlanta',
    metaDescription:
      'Commercial roofing services in Canton, GA and metro Atlanta — low-slope systems, metal, repairs, and maintenance programs that protect your business. Call (404) 444-4476.',
    headline: 'Roofing that keeps your business open.',
    intro:
      "A commercial roof problem is a business problem — inventory, equipment, and operations are all under it. We service low-slope and metal commercial systems with scheduling that works around your business hours and honest guidance about repair versus replacement.",
    problems: [
      'Ponding water and membrane deterioration on low-slope roofs',
      'Leaks threatening inventory, equipment, or tenants',
      'Aging metal systems with fastener and seam failures',
      'No maintenance history and an insurance carrier asking questions',
    ],
    process: [
      { title: 'Assessment and priorities', detail: 'We document current condition and separate must-fix-now items from plan-for-later ones so you can budget.' },
      { title: 'Minimal-disruption scheduling', detail: 'Work is scheduled around your operating hours where possible.' },
      { title: 'Repair or re-cover', detail: 'From targeted membrane and flashing repairs to full system replacement, scoped to what the roof actually needs.' },
      { title: 'Maintenance program', detail: 'Optional scheduled inspections that catch small failures before they hit the ceiling tiles.' },
    ],
    faqs: [
      { question: 'What types of commercial roofs do you service?', answer: 'Low-slope membrane systems, metal roofs, and steep-slope shingle roofs on commercial buildings such as offices, retail, and light industrial.' },
      { question: 'Can you work around business hours?', answer: 'Yes. We plan noisy or disruptive phases outside your peak hours where the scope allows.' },
      { question: 'Do you offer maintenance contracts?', answer: 'Yes — scheduled inspections and preventive maintenance that extend roof life and create the documentation insurers like to see. See our maintenance plans page.' },
    ],
    relatedSlugs: ['maintenance-plans', 'metal-roofing', 'roof-inspection'],
  },
  {
    slug: 'storm-damage',
    name: 'Storm Damage',
    shortName: 'Storm',
    icon: CloudLightning,
    teaser: 'Wind and hail damage documentation, emergency stabilization, and full restoration.',
    metaTitle: 'Storm Damage Roof Repair in Canton & North Georgia',
    metaDescription:
      'Storm damage roof repair in Canton, GA and North Georgia. Wind and hail damage documented properly, emergency tarping, and insurance-ready reports. Call (404) 444-4476.',
    headline: 'After the storm, the next steps matter most.',
    intro:
      "Georgia storms don't announce which roofs they've damaged — hail bruising and lifted shingles are often invisible from the ground. We document storm damage thoroughly, stabilize what's urgent, and represent the damage honestly. No scare tactics, no invented damage, no promises about your claim we can't keep.",
    problems: [
      'Hail impacts bruising shingles and cracking mats — often invisible from the ground',
      'Wind-lifted or creased shingles that will leak in the next rain',
      'Fallen limbs and punctures needing immediate tarping',
      'Adjuster visits scheduled without your own documentation in hand',
    ],
    process: [
      { title: 'Stabilize first', detail: 'Active leaks and punctures get tarped and secured before anything else.' },
      { title: 'Document everything', detail: 'Slope-by-slope photos of impacts, creases, and collateral damage — gutters, vents, screens — organized the way adjusters expect.' },
      { title: 'Meet your adjuster', detail: 'We can be present for the adjuster inspection to make sure the damage we documented is seen. Decisions remain your insurer’s.' },
      { title: 'Restore', detail: 'Once scope is settled, we complete repairs or replacement with quality materials and keep you informed throughout.' },
    ],
    faqs: [
      { question: 'How do I know if my roof has hail damage?', answer: 'From the ground, you often can’t. Look for dented gutters, downspouts, or window screens as clues — then get a professional inspection. Hail bruises shingle mats in ways that only show up close.' },
      { question: 'Should I file a claim before or after an inspection?', answer: 'Get an inspection first. If damage is minor, filing a claim that gets denied still counts against your history. We tell you honestly whether what we find is worth a claim.' },
      { question: 'Does a storm check on your website prove my roof is damaged?', answer: 'No. Our storm address checker shows recent weather activity near your address — it is informational only. Only a physical inspection can confirm actual roof damage.' },
    ],
    relatedSlugs: ['insurance-claims', 'emergency-roofing', 'roof-inspection', 'roof-replacement'],
    emergency: true,
  },
  {
    slug: 'insurance-claims',
    name: 'Insurance Claim Assistance',
    shortName: 'Insurance',
    icon: FileCheck2,
    teaser: 'Thorough documentation and adjuster coordination — without the false promises.',
    metaTitle: 'Roof Insurance Claim Assistance in Georgia',
    metaDescription:
      'Insurance claim assistance for storm-damaged roofs in Canton, GA and North Georgia. Thorough documentation, adjuster coordination, honest guidance. Call (404) 444-4476.',
    headline: 'Insurance claims are confusing. Your roofer shouldn’t be.',
    intro:
      "The claims process after storm damage is where most homeowners feel lost — deadlines, adjusters, supplements, depreciation. We've been through it hundreds of times. Our job is to document your damage properly and make sure nothing legitimate gets missed. What we will never do is promise an approval, inflate a scope, or tell you what your insurer will decide.",
    problems: [
      'Not knowing whether damage justifies a claim at all',
      'Adjuster scopes that miss slopes, accessories, or code-required items',
      'Confusion about deductibles, depreciation, and supplements',
      'Storm-chasing contractors pressuring you to sign before an inspection',
    ],
    process: [
      { title: 'Honest pre-claim inspection', detail: 'Before you call your insurer, we tell you whether the damage we find is likely worth a claim — including when it isn’t.' },
      { title: 'Insurance-grade documentation', detail: 'Photo documentation organized by slope and damage type, in the format adjusters work with.' },
      { title: 'Adjuster meeting', detail: 'We can meet your adjuster on site so documented damage is actually reviewed.' },
      { title: 'Scope reconciliation and build', detail: 'If the claim is approved, we reconcile the insurer’s scope with real conditions, file supplements when legitimate items are missed, and complete the work.' },
    ],
    faqs: [
      { question: 'Do you guarantee my claim will be approved?', answer: 'No — and you should be wary of anyone who does. Coverage decisions belong to your insurance company. What we guarantee is thorough, honest documentation so your claim is judged on complete information.' },
      { question: 'What is a supplement?', answer: 'A request to add legitimate items the original adjuster scope missed — like code-required components or damage found during tear-off. We file supplements with documentation when they’re justified.' },
      { question: 'Will my rates go up if I file?', answer: 'That depends on your insurer and policy. Weather-related claims are generally treated differently from negligence claims, but we recommend asking your agent about your specific policy.' },
    ],
    relatedSlugs: ['storm-damage', 'roof-replacement', 'water-damage-restoration'],
  },
  {
    slug: 'emergency-roofing',
    name: 'Emergency Roofing',
    shortName: 'Emergency',
    icon: ShieldAlert,
    teaser: '24/7 response for active leaks, storm punctures, and urgent stabilization.',
    metaTitle: '24/7 Emergency Roof Repair in Canton & North Georgia',
    metaDescription:
      'Emergency roof repair in Canton, GA — open 24 hours. Active leaks tarped and stabilized fast, then repaired right. Call (404) 444-4476 any time.',
    headline: 'Water coming in right now? We answer 24/7.',
    intro:
      "When water is actively entering your home, every hour matters — for the roof, the drywall, the insulation, and the air quality that follows. We're open 24 hours because storms don't keep business hours. First we stop the intrusion; then we plan the permanent fix.",
    problems: [
      'Active leaks during or after a storm',
      'Tree limbs or debris through the roof deck',
      'Shingles or panels torn off in high wind',
      'Water spreading into ceilings, walls, and insulation',
    ],
    process: [
      { title: 'Call — a person answers', detail: `Call ${'(404) 444-4476'} any time. Describe what's happening; we'll give immediate safety guidance.` },
      { title: 'Rapid stabilization', detail: 'Tarping, temporary sealing, and debris removal to stop active water intrusion.' },
      { title: 'Damage assessment', detail: 'Once stable, we document the damage fully — including for your insurance claim if the cause is a covered event.' },
      { title: 'Permanent repair', detail: 'We schedule and complete the real fix, and address any water damage inside with our restoration team.' },
    ],
    faqs: [
      { question: 'What should I do while I wait?', answer: 'Move belongings out of the water path, contain drips with buckets, and stay off ladders and the roof. If water is near electrical fixtures or the ceiling is sagging, keep clear of the area — sagging drywall can fail suddenly.' },
      { question: 'Is a tarp a permanent fix?', answer: 'No — a tarp buys time safely. It protects your home while insurance, materials, and weather line up for the permanent repair.' },
      { question: 'Do you really answer at 3 a.m.?', answer: 'Yes. We are open 24 hours, Monday through Sunday. Storm damage doesn’t wait for morning, so neither do we.' },
    ],
    relatedSlugs: ['water-damage-restoration', 'storm-damage', 'roof-repair'],
    emergency: true,
  },
  {
    slug: 'water-damage-restoration',
    name: 'Water Damage Restoration',
    shortName: 'Water Damage',
    icon: Droplets,
    teaser: 'Fast water extraction, drying, and restoration to stop mold before it starts.',
    metaTitle: 'Water Damage Restoration in Canton & North Georgia',
    metaDescription:
      'Water damage restoration in Canton, GA — extraction, structural drying, and repair after roof leaks and storms. Fast response prevents mold. Call (404) 444-4476.',
    headline: 'The leak is only half the problem. The water that got in is the other half.',
    intro:
      "Water that enters through a damaged roof doesn't just stain a ceiling — it soaks insulation, wicks into framing, and gives mold the 24–48 hour head start it needs. Because we handle both roofing and restoration, one call covers the entry point and everything the water touched.",
    problems: [
      'Soaked insulation and drywall after a roof leak',
      'Musty odors signaling moisture trapped in walls or attics',
      'Mold risk in the first 24–48 hours after water intrusion',
      'Buckling floors and swollen trim from standing water',
    ],
    process: [
      { title: 'Stop the source', detail: 'Restoration is pointless while water keeps coming in. We stabilize the roof first.' },
      { title: 'Extract and dry', detail: 'Water extraction, then structural drying with air movers and dehumidifiers, monitored with moisture meters until materials read dry.' },
      { title: 'Prevent mold', detail: 'Fast drying plus antimicrobial treatment where warranted — the goal is preventing mold, not remediating it later.' },
      { title: 'Restore', detail: 'Drywall, insulation, paint, and trim brought back to pre-loss condition.' },
    ],
    faqs: [
      { question: 'How fast does mold start after a leak?', answer: 'Mold can begin colonizing wet materials within 24–48 hours. That window is why fast water response matters more than almost anything else in preventing long-term damage.' },
      { question: 'Does insurance cover water damage from a roof leak?', answer: 'Sudden water damage from a covered roof event is often covered; long-term seepage from deferred maintenance often is not. We document the cause clearly so your claim reflects what actually happened.' },
      { question: 'Can wet insulation be dried and kept?', answer: 'Fiberglass batts sometimes; blown cellulose almost never — it compacts and loses R-value. We tell you which materials are worth saving and which should be replaced.' },
    ],
    relatedSlugs: ['emergency-roofing', 'roof-repair', 'insurance-claims'],
    emergency: true,
  },
  {
    slug: 'siding',
    name: 'Siding',
    shortName: 'Siding',
    icon: Warehouse,
    teaser: 'Siding repair and replacement that protects the walls the roof can’t.',
    metaTitle: 'Siding Repair & Replacement in Canton, GA',
    metaDescription:
      'Siding repair and replacement in Canton, GA and North Georgia. Storm-damaged, warped, or aging siding replaced with durable materials. Call (404) 444-4476.',
    headline: 'Your roof sheds the water. Your siding takes the sideways hit.',
    intro:
      "Wind-driven rain, hail, and sun work on your walls the same way they work on your roof. Damaged or gapped siding lets moisture reach sheathing and framing where it does quiet, expensive damage. We repair and replace siding — often alongside roof work after the same storm.",
    problems: [
      'Hail-cracked or wind-torn siding panels',
      'Warping and fading from southern sun exposure',
      'Gaps and failed caulk letting moisture behind the wall',
      'Woodpecker holes, rot, and pest entry points',
    ],
    process: [
      { title: 'Wall-by-wall inspection', detail: 'We document damage on every elevation — storm damage is often concentrated on one or two sides.' },
      { title: 'Match or upgrade', detail: 'Repairs matched to existing material where possible, or full replacement options if the siding line is discontinued or failing broadly.' },
      { title: 'Moisture barrier check', detail: 'Sheathing and house wrap inspected and corrected before new siding goes on.' },
      { title: 'Installation and sealing', detail: 'Panels, trim, and caulking completed and inspected.' },
    ],
    faqs: [
      { question: 'Can hail damage siding the same storm that hit my roof?', answer: 'Yes — and insurers often cover both under the same claim. We document roof and siding damage together so nothing is missed.' },
      { question: 'Do you repair sections or only full walls?', answer: 'We do both. If your siding is matchable and the damage is isolated, a section repair is the honest recommendation.' },
    ],
    relatedSlugs: ['storm-damage', 'gutters', 'insurance-claims'],
  },
  {
    slug: 'gutters',
    name: 'Gutters',
    shortName: 'Gutters',
    icon: Hammer,
    teaser: 'Seamless gutters and guards that move water away from your foundation.',
    metaTitle: 'Seamless Gutters & Gutter Guards in Canton, GA',
    metaDescription:
      'Seamless gutter installation, repair, and gutter guards in Canton, GA. Protect your roofline, siding, and foundation. Call (404) 444-4476.',
    headline: 'A roof is only as good as where the water goes next.',
    intro:
      "Gutters are the unglamorous half of your roof system. When they sag, clog, or overflow, water backs under shingles, streaks siding, and pools at the foundation. We install seamless gutters cut on site to your exact roofline, plus guards that keep Georgia's pine needles and oak leaves out.",
    problems: [
      'Overflowing gutters spilling at the foundation',
      'Sagging runs pulling away from fascia',
      'Clogs from pine needles and leaves requiring constant cleaning',
      'Erosion trenches and crawlspace moisture below the roofline',
    ],
    process: [
      { title: 'Flow assessment', detail: 'We size gutters and downspouts to your roof area and pitch — undersized gutters overflow no matter how clean they are.' },
      { title: 'Seamless fabrication on site', detail: 'Gutter runs are formed to exact length at your home, eliminating mid-run seams that leak.' },
      { title: 'Correct pitch and anchoring', detail: 'Hidden hangers into solid fascia, pitched to drain fully.' },
      { title: 'Guards if wanted', detail: 'Guard options that match your tree cover, honestly assessed — some homes genuinely don’t need them.' },
    ],
    faqs: [
      { question: 'Are gutter guards worth it?', answer: 'Under heavy tree cover, usually yes — they turn a four-times-a-year chore into an occasional rinse. On homes with little overhead tree cover, we’ll tell you to save the money.' },
      { question: 'What are seamless gutters?', answer: 'Gutter runs formed from a single piece of aluminum cut to your home’s exact measurements, with joints only at corners and downspouts. Fewer seams means fewer leaks.' },
    ],
    relatedSlugs: ['siding', 'roof-repair', 'maintenance-plans'],
  },
  {
    slug: 'roof-inspection',
    name: 'Roof Inspection',
    shortName: 'Inspection',
    icon: Search,
    teaser: 'Honest, documented inspections for storm checks, real estate, and peace of mind.',
    metaTitle: 'Professional Roof Inspection in Canton, GA',
    metaDescription:
      'Professional roof inspections in Canton, GA — storm damage checks, real-estate inspections, and maintenance assessments with photo documentation. Call (404) 444-4476.',
    headline: 'Know what’s actually up there.',
    intro:
      "Most homeowners see their roof from the driveway. We see it up close — every slope, penetration, flashing detail, and the attic side too. You get photo documentation and a straight answer: what's fine, what's aging, what needs attention now. If the answer is 'your roof is fine,' that's what we tell you.",
    problems: [
      'Post-storm uncertainty about invisible hail or wind damage',
      'Buying or selling a home and needing roof condition documented',
      'A roof past year 10 with no inspection history',
      'Interior stains with no obvious source',
    ],
    process: [
      { title: 'Surface inspection', detail: 'Every slope walked or closely examined: shingle condition, flashing, penetrations, valleys, and ridge.' },
      { title: 'Attic-side check', detail: 'Decking, ventilation, and any signs of moisture intrusion from below.' },
      { title: 'Photo report', detail: 'Documented findings with photos, organized by area, in plain language.' },
      { title: 'Honest recommendation', detail: 'Repair, monitor, or replace — with reasoning you can verify in the photos.' },
    ],
    faqs: [
      { question: 'How often should a roof be inspected?', answer: 'Annually after year 10, after any significant hail or wind event, and before buying or selling a home.' },
      { question: 'Is the inspection a sales pitch?', answer: 'No. A meaningful share of our inspections end with "your roof is in good shape." An inspection that always finds a problem isn’t an inspection.' },
    ],
    relatedSlugs: ['maintenance-plans', 'storm-damage', 'roof-repair'],
  },
  {
    slug: 'maintenance-plans',
    name: 'Maintenance Plans',
    shortName: 'Maintenance',
    icon: AlarmClockCheck,
    teaser: 'Scheduled inspections and upkeep that catch small problems while they’re small.',
    metaTitle: 'Roof Maintenance Plans in Canton, GA',
    metaDescription:
      'Scheduled roof maintenance plans in Canton, GA — annual inspections, minor repairs, and documentation that extends roof life. Call (404) 444-4476.',
    headline: 'The cheapest roof repair is the one you never need.',
    intro:
      "Roofs rarely fail all at once — they fail through small things left alone: a lifted shingle, a cracked pipe boot, a clogged valley. A maintenance plan puts eyes on your roof on a schedule, fixes small issues on the spot, and builds a documented history that helps with warranties and insurance alike.",
    problems: [
      'Small failures (pipe boots, sealant, fasteners) quietly becoming leaks',
      'No documentation of roof condition for warranty or insurance purposes',
      'Debris and clogged valleys shortening shingle life',
      'Commercial properties needing scheduled, recorded upkeep',
    ],
    process: [
      { title: 'Baseline inspection', detail: 'Full documented inspection establishing your roof’s current condition.' },
      { title: 'Scheduled visits', detail: 'Annual or semi-annual inspections timed around storm season.' },
      { title: 'Small fixes included', detail: 'Minor items — sealant, exposed fasteners, small flashing touch-ups — handled during the visit.' },
      { title: 'Condition history', detail: 'A running photo record of your roof over time, useful for claims, warranties, and resale.' },
    ],
    faqs: [
      { question: 'Does maintenance actually extend roof life?', answer: 'Yes — the failure points on most roofs are small, fixable details, not the field shingles. Catching them early routinely adds years of service life.' },
      { question: 'Do you offer plans for commercial buildings?', answer: 'Yes, with scheduling and documentation suited to commercial ownership — see our commercial roofing page.' },
    ],
    relatedSlugs: ['roof-inspection', 'commercial-roofing', 'gutters'],
  },
];

export const SERVICES_BY_SLUG = new Map(SERVICES.map((s) => [s.slug, s]));
