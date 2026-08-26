import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Settings, Play, Square, Bot, Plus, Trash2, Zap, Loader2, Search, Eye, EyeOff, Shield, Globe, Lock, Save, Check, ChevronRight, Copy, Download, Upload, RotateCcw, X, AlertTriangle, CheckCircle, XCircle, Clock, Radar, Key, ClipboardPaste, Layers, ArrowDownToLine, ArrowUpToLine, Sparkles, Database, Activity, Pencil, RefreshCw, AlertCircle, FlaskConical, DollarSign, User, MapPin, Hash, Cpu } from "lucide-react";
import { PaymentSlugFields } from "@/components/configs/PaymentSlugFields";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const normaliseUrl = (u: string) =>
  u.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "").split("?")[0];

// ── Flow metadata: human labels, descriptions, required fields ────────────────
const FLOW_META: Record<string, Record<string, { label: string; desc: string; needs: string[]; optional?: string[] }>> = {
  stripe: {
    auth:                           { label: "Stripe Auth (SetupIntent)",        desc: "Creates a SetupIntent — verifies the card without charging. Cheapest real check.", needs: ["publicKey"], optional: ["siteUrl", "secretKey"] },
    charges:                        { label: "Stripe Charges",                   desc: "Direct charge via Charges API — creates a charge token immediately.", needs: ["publicKey"], optional: ["secretKey"] },
    payment_intents:                { label: "Payment Intents (WC default)",     desc: "Full WooCommerce flow: add-to-cart → checkout → confirm PaymentIntent.", needs: ["publicKey", "siteUrl"], optional: ["secretKey"] },
    tokenize:                       { label: "Tokenize Only",                    desc: "Creates a tok_ token. Proves card format but does NOT verify funds or charge.", needs: ["publicKey"], optional: ["secretKey"] },
    standard:                       { label: "Standard WC Stripe",               desc: "WooCommerce wc_stripe_process_payment AJAX action.", needs: ["publicKey", "siteUrl"], optional: ["secretKey"] },
    charitable:                     { label: "Charitable (WP Donation)",         desc: "WordPress Charitable plugin — scrapes nonce + creates pm_ then posts donation.", needs: ["publicKey", "siteUrl"], optional: ["donatePath", "secretKey"] },
    givewp:                         { label: "GiveWP v2",                        desc: "GiveWP donation form via admin-ajax give_process_donation action.", needs: ["publicKey", "siteUrl"], optional: ["giveFormId", "donationType", "secretKey"] },
    givewp_v3:                      { label: "GiveWP v3",                        desc: "GiveWP v3 REST API donation endpoint.", needs: ["publicKey", "siteUrl"], optional: ["giveFormId", "donationType", "secretKey"] },
    gravityforms:                   { label: "Gravity Forms + Stripe",           desc: "Gravity Forms with Stripe add-on — scrapes gf_stripe_payment_intent nonce.", needs: ["publicKey", "siteUrl"], optional: ["gfFormId", "secretKey"] },
    wp_full_stripe:                 { label: "WP Full Stripe",                   desc: "Mammothology WP Full Stripe plugin — payment + donation form variants. Scrapes wpfs-form-name + amount, tokenizes via Stripe API, POSTs to admin-ajax.", needs: ["publicKey", "siteUrl"], optional: ["wpFsFormName", "donatePath", "secretKey"] },
    "3d_secure":                    { label: "3D Secure",                        desc: "Forces the 3DS challenge path — tests 3DS-enrolled cards.", needs: ["publicKey", "siteUrl"], optional: ["secretKey"] },
    checkout_session:               { label: "Stripe Checkout Session",          desc: "Hosted Stripe Checkout: creates a session URL and submits the card through it.", needs: ["publicKey", "siteUrl"], optional: ["secretKey"] },
    wc_stripe_confirm_setup_intent: { label: "WC Setup Intent Confirm",         desc: "WooCommerce wc_stripe_create_and_confirm_setup_intent AJAX — verify-only, no charge.", needs: ["publicKey", "siteUrl"], optional: ["secretKey"] },
    stripe_page_confirm:            { label: "Stripe Page Confirm",              desc: "Scrapes a Stripe-powered payment page and submits the card directly to it.", needs: ["publicKey", "siteUrl"], optional: ["secretKey"] },
  },
  shopify: {
    pci:      { label: "Shopify PCI Checkout",    desc: "Modern Shopify PCI flow: PCI tokenize → SubmitForCompletion GQL → PollForReceipt GQL × 2.", needs: ["siteUrl"], optional: ["checkoutScope", "productHandle"] },
    standard: { label: "Shopify Standard",         desc: "Legacy Shopify checkout flow.", needs: ["siteUrl"] },
  },
  braintree: {
    standard:            { label: "Braintree Standard",          desc: "Client SDK tokenize then server-side transaction via the site's checkout.", needs: ["btClientToken", "siteUrl"] },
    graphql:             { label: "Braintree GraphQL",            desc: "Braintree GraphQL API tokenize flow.", needs: ["btClientToken", "siteUrl"] },
    drop_in:             { label: "Drop-in UI",                   desc: "Braintree Drop-in component checkout flow.", needs: ["btClientToken", "siteUrl"] },
    hosted_fields:       { label: "Hosted Fields",                desc: "Braintree Hosted Fields iframe — tokenizes and submits.", needs: ["btClientToken", "siteUrl"] },
    bigcommerce_stencil: { label: "BigCommerce Stencil",          desc: "BigCommerce Stencil storefront with Braintree.", needs: ["btClientToken", "siteUrl"] },
  },
  payeezy: {
    standard: { label: "First Data Payeezy",  desc: "Payeezy hosted checkout — authenticates with an existing logged-in session cookie.", needs: ["siteUrl"], optional: ["rawCookies"] },
  },
  paypal: {
    standard:        { label: "PayPal Standard (PPCP)",       desc: "PayPal PPCP button flow via the site's PayPal Commerce integration.", needs: ["siteUrl"] },
    express:         { label: "PayPal Express Checkout",      desc: "Legacy PayPal Express Checkout flow.", needs: ["siteUrl"] },
    advanced:        { label: "PayPal Advanced (ACDC)",       desc: "PayPal Advanced Card Fields — direct card charge via PPCP ACDC without redirect.", needs: ["siteUrl"] },
    givewp_commerce: { label: "GiveWP PayPal Commerce",      desc: "GiveWP donation with PayPal Commerce gateway — auto-detects form tokens from URL.", needs: ["siteUrl"] },
    paypal_commerce: { label: "PayPal Commerce",             desc: "Generic PayPal Commerce via Braintree token — paste donation URL for auto-setup.", needs: ["siteUrl"] },
  },
};

interface BulkUrlResult {
  index: number;
  url: string;
  status: "pending" | "scanning" | "success" | "failed" | "error" | "skipped";
  reason?: string;
  gate?: { id: string; name: string; gateType: string; subType: string };
  publicKey?: string | null;
  btToken?: boolean;
  confidence?: number;
  signals?: string[];
  crawledPaths?: number;
  subType?: string;
  settings?: Record<string, any>;
  progress?: { current: number; total: number; configured: number; failed: number };
}

export default function Configs() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [newGateOpen, setNewGateOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkUrls, setBulkUrls] = useState("");
  const [bulkResults, setBulkResults] = useState<BulkUrlResult[]>([]);
  const [bulkScanning, setBulkScanning] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ current: number; total: number; configured: number; failed: number } | null>(null);
  const [bulkExpandedIdx, setBulkExpandedIdx] = useState<number | null>(null);
  const [bulkStartTime, setBulkStartTime] = useState<number | null>(null);
  const [bulkAutoScroll, setBulkAutoScroll] = useState(true);
  const [bulkCompleted, setBulkCompleted] = useState(false);
  const [bulkElapsedLive, setBulkElapsedLive] = useState(0);
  const bulkAbortRef = useRef<AbortController | null>(null);
  const bulkScrollRef = useRef<HTMLDivElement>(null);
  const [newGate, setNewGate] = useState({ name: "", gateType: "", subType: "", url: "", settings: {} as Record<string, any> });
  const [detecting, setDetecting] = useState(false);
  const [detectionResult, setDetectionResult] = useState<any>(null);
  const [expandedGate, setExpandedGate] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [showAdminPwd, setShowAdminPwd] = useState(false);
  const [adminPwd, setAdminPwd] = useState("");
  const [adminPwdSaved, setAdminPwdSaved] = useState(false);
  const [redetecting, setRedetecting] = useState<{ running: boolean; done: number; total: number; updated: number; failed: number }>({ running: false, done: 0, total: 0, updated: 0, failed: 0 });

  // ── Gate import from .py / network-capture .json (HAR) ──
  const [importPyOpen, setImportPyOpen] = useState(false);
  const [importParsing, setImportParsing] = useState(false);
  const [importPreview, setImportPreview] = useState<any>(null);   // ParsedGate
  const [importFilename, setImportFilename] = useState("");
  const pyHarFileRef = useRef<HTMLInputElement>(null);

  // Gate edit state
  const [editGateOpen, setEditGateOpen] = useState(false);
  const [editGate, setEditGate] = useState<any>(null);
  const [editDetecting, setEditDetecting] = useState(false);
  const [editTesting, setEditTesting] = useState(false);
  const [editTestResult, setEditTestResult] = useState<{ status: string; response: string; latency: number } | null>(null);
  const [editTab, setEditTab] = useState<"config"|"keys"|"amount"|"billing"|"advanced">("config");
  const importFileRef = useRef<HTMLInputElement>(null);

  const { data: botSettings } = useQuery({ queryKey: ["/api/bot-settings"] });
  const { data: gates } = useQuery({ queryKey: ["/api/gates"] });
  const { data: gateTypes } = useQuery({ queryKey: ["/api/gates/types"] });

  // Live health stats for the gate being edited — refreshes every 10s while dialog is open.
  const { data: gateHealth } = useQuery<{ checks10min: number; blocks: number; lastCheck: number | null; url: string | null }>({
    queryKey: ["/api/gates", editGate?.id, "health"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/gates/${editGate.id}/health`);
      return res.json();
    },
    enabled: !!editGate?.id && editGateOpen,
    refetchInterval: 10_000,
  });

  // Derived from query data — declared here so all hooks below can reference them
  const settings = botSettings as any;
  const gateList = (gates as any[]) || [];
  const typesList = (gateTypes as any[]) || [];
  const selectedTypeSubtypes = typesList.find((t: any) => t.id === newGate.gateType)?.subtypes || [];

  // Live elapsed timer for bulk scan
  useEffect(() => {
    if (!bulkScanning || !bulkStartTime) return;
    const interval = setInterval(() => {
      setBulkElapsedLive(Math.round((Date.now() - bulkStartTime) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [bulkScanning, bulkStartTime]);

  // Auto-scroll bulk results
  useEffect(() => {
    if (bulkAutoScroll && bulkScrollRef.current) {
      bulkScrollRef.current.scrollTop = bulkScrollRef.current.scrollHeight;
    }
  }, [bulkResults, bulkAutoScroll]);

  // Computed bulk stats
  const bulkGateTypeDist = useMemo(() => {
    const dist: Record<string, number> = {};
    bulkResults.filter(r => r.status === "success").forEach(r => {
      const t = r.gate?.gateType || "unknown";
      dist[t] = (dist[t] || 0) + 1;
    });
    return dist;
  }, [bulkResults]);

  const bulkKeysFound = useMemo(() => {
    return bulkResults.filter(r => r.status === "success" && r.publicKey).length;
  }, [bulkResults]);

  const bulkAvgConfidence = useMemo(() => {
    const successes = bulkResults.filter(r => r.status === "success" && r.confidence);
    if (successes.length === 0) return 0;
    return Math.round(successes.reduce((a, r) => a + (r.confidence || 0), 0) / successes.length);
  }, [bulkResults]);

  const updateSettingsMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await apiRequest("PATCH", "/api/bot-settings", data);
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/bot-settings"] }),
  });

  const startBotMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/bot/start");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bot-settings"] });
      toast({ title: "SYSTEM ONLINE", description: "Telegram bot polling started." });
    },
    onError: (error: any) => {
      toast({ title: "ERROR", description: error.message, variant: "destructive" });
    },
  });

  const stopBotMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/bot/stop");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bot-settings"] });
      toast({ title: "SYSTEM OFFLINE", description: "Telegram bot polling stopped.", variant: "destructive" });
    },
  });

  const createGateMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await apiRequest("POST", "/api/gates", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/gates"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
      setNewGateOpen(false);
      setNewGate({ name: "", gateType: "", subType: "", url: "", settings: {} });
      setDetectionResult(null);
      toast({ title: "GATE CREATED", description: "New gate configuration added." });
    },
  });

  const toggleGateMutation = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      const res = await apiRequest("PATCH", `/api/gates/${id}`, { active });
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/gates"] }),
  });

  const deleteGateMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/gates/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/gates"] });
      toast({ title: "DELETED", description: "Gate configuration removed." });
    },
  });

  const updateGateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      const res = await apiRequest("PATCH", `/api/gates/${id}`, data);
      return res.json();
    },
    onSuccess: async (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/gates"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
      // If the gate has autoValidate enabled, run a test card before closing the dialog.
      const shouldValidate = editGate?.settings?.autoValidate === true;
      if (shouldValidate) {
        toast({ title: "VALIDATING", description: "Running test card through the saved gate…" });
        try { await handleEditTest(); } catch { /* surfaced via editTestResult banner */ }
        // Don't auto-close — let the user inspect the validation result.
      } else {
        setEditGateOpen(false);
        setEditGate(null);
      }
      toast({ title: "GATE UPDATED", description: "Gate configuration saved." });
    },
    onError: (err: any) => {
      toast({ title: "UPDATE FAILED", description: err.message, variant: "destructive" });
    },
  });

  const openEditGate = (gate: any) => {
    setEditGate(JSON.parse(JSON.stringify(gate))); // deep clone
    setPolishResult(null);
    setFailureSuggestions(null);
    setEditGateOpen(true);
    setEditTestResult(null);
    setDetectionResult(null);
  };

  const handleRedetectAll = async () => {
    if (!gateList.length || redetecting.running) return;
    if (!confirm(`Re-detect ${gateList.length} gates? Each one is re-crawled and saved with merged settings.`)) return;
    setRedetecting({ running: true, done: 0, total: gateList.length, updated: 0, failed: 0 });
    let updated = 0, failed = 0;
    for (let i = 0; i < gateList.length; i++) {
      const g = gateList[i];
      try {
        const res = await apiRequest("POST", "/api/gates/detect-url", { url: g.url });
        const result = await res.json();
        if (result.gateType && result.gateType !== "unknown") {
          await apiRequest("PATCH", `/api/gates/${g.id}`, {
            gateType: result.gateType,
            subType: result.subType || g.subType || "standard",
            // Merge fresh detection settings on top of existing user-set overrides.
            settings: { ...(g.settings || {}), ...(result.settings || {}) },
          });
          updated++;
        } else {
          failed++;
        }
      } catch { failed++; }
      setRedetecting(prev => ({ ...prev, done: i + 1, updated, failed }));
    }
    queryClient.invalidateQueries({ queryKey: ["/api/gates"] });
    setRedetecting({ running: false, done: 0, total: 0, updated: 0, failed: 0 });
    toast({ title: "RE-DETECT COMPLETE", description: `${updated} updated · ${failed} failed` });
  };

  const handleEditRedetect = async () => {
    if (!editGate?.url) return;
    setEditDetecting(true);
    try {
      const res = await apiRequest("POST", "/api/gates/detect-url", { url: editGate.url });
      const result = await res.json();
      if (result.gateType && result.gateType !== "unknown") {
        setEditGate((prev: any) => ({
          ...prev,
          gateType: result.gateType,
          subType: result.subType || "standard",
          settings: { ...prev.settings, ...result.settings },
        }));
        toast({ title: "RE-DETECTED", description: `${result.gateType.toUpperCase()} — ${result.confidence}% confidence, ${result.crawledPaths?.length || 0} paths` });
      } else {
        toast({ title: "NO GATEWAY FOUND", description: "Could not detect a payment gateway at this URL.", variant: "destructive" });
      }
    } catch (err: any) {
      toast({ title: "DETECTION FAILED", description: err.message, variant: "destructive" });
    } finally {
      setEditDetecting(false);
    }
  };

  // ── Scrape-hints: fetch the gate URL server-side and pull common fields out of HTML
  const [hintLoading, setHintLoading] = useState(false);
  const [scrapedHints, setScrapedHints] = useState<Record<string, string> | null>(null);
  const handleScrapeHints = async () => {
    if (!editGate?.url) return;
    setHintLoading(true);
    setScrapedHints(null);
    try {
      const res = await apiRequest("POST", "/api/gates/scrape-hints", { url: editGate.url });
      const data = await res.json();
      const hints = data.hints || {};
      setScrapedHints(hints);
      const found = Object.keys(hints).length;
      toast({
        title: found ? "HINTS EXTRACTED" : "NO HINTS FOUND",
        description: found ? `${found} field(s) found — review below to apply` : "No common gate fields visible on this page",
      });
    } catch (e: any) {
      toast({ title: "SCRAPE FAILED", description: e.message, variant: "destructive" });
    } finally {
      setHintLoading(false);
    }
  };
  const applyHint = (key: string, value: string) => {
    setEditSetting(key, value);
    toast({ title: "APPLIED", description: `${key} ← ${value.slice(0, 24)}${value.length > 24 ? "…" : ""}` });
  };

  // ── Gate profiles (localStorage): save/load named bundles of settings
  const [profiles, setProfiles] = useState<Array<{ name: string; gateType: string; subType: string; settings: Record<string, any> }>>(() => {
    try { return JSON.parse(localStorage.getItem("gate-profiles") || "[]"); } catch { return []; }
  });
  const persistProfiles = (next: typeof profiles) => {
    setProfiles(next);
    try { localStorage.setItem("gate-profiles", JSON.stringify(next)); } catch { /* quota — ignore */ }
  };
  const saveProfile = () => {
    if (!editGate) return;
    const name = prompt("Profile name?", `${editGate.name || editGate.gateType} preset`);
    if (!name?.trim()) return;
    const next = [...profiles.filter(p => p.name !== name.trim()), {
      name: name.trim(),
      gateType: editGate.gateType,
      subType: editGate.subType || "standard",
      settings: { ...(editGate.settings || {}) },
    }];
    persistProfiles(next);
    toast({ title: "PROFILE SAVED", description: name });
  };
  const applyProfile = (p: typeof profiles[0]) => {
    setEditGate((prev: any) => ({
      ...prev,
      gateType: p.gateType,
      subType: p.subType,
      settings: { ...(prev.settings || {}), ...p.settings },
    }));
    toast({ title: "PROFILE APPLIED", description: `${p.name} — merged on top of current settings` });
  };
  const deleteProfile = (name: string) => {
    if (!confirm(`Delete profile "${name}"?`)) return;
    persistProfiles(profiles.filter(p => p.name !== name));
  };

  // ── Failure-pattern suggestions
  const [failureSuggestions, setFailureSuggestions] = useState<{ sampleSize: number; suggestions: Array<{ reason: string; settings: Record<string, any>; confidence: number }> } | null>(null);
  const [analyzingFailures, setAnalyzingFailures] = useState(false);
  const analyzeFailures = async () => {
    if (!editGate?.id) return;
    setAnalyzingFailures(true);
    try {
      const res = await apiRequest("GET", `/api/gates/${editGate.id}/failure-suggestions`);
      const data = await res.json();
      setFailureSuggestions(data);
      if (data.sampleSize === 0) {
        toast({ title: "NO DATA", description: "No recent check results for this gate yet" });
      } else if (!data.suggestions?.length) {
        toast({ title: "LOOKS HEALTHY", description: `Reviewed ${data.sampleSize} results — no anomalies detected` });
      }
    } catch (e: any) {
      toast({ title: "ANALYSIS FAILED", description: e.message, variant: "destructive" });
    } finally {
      setAnalyzingFailures(false);
    }
  };
  const applySuggestion = (settings: Record<string, any>) => {
    for (const [k, v] of Object.entries(settings)) setEditSetting(k, v);
    toast({ title: "SUGGESTION APPLIED", description: Object.keys(settings).join(", ") });
  };

  // ── AI "Suggest & Polish" for the open gate
  const [polishResult, setPolishResult] = useState<{
    detection: any; analysis: string; suggestions: Array<{ reason: string; settings: Record<string, any>; confidence: number }>; polishedSettings: Record<string, any>;
  } | null>(null);
  const [polishing, setPolishing] = useState(false);
  const aiPolish = async () => {
    if (!editGate?.url) {
      toast({ title: "NO URL", description: "Gate has no URL to analyze", variant: "destructive" });
      return;
    }
    setPolishing(true);
    try {
      const res = await apiRequest("POST", "/api/ai/gate-suggest", {
        gateType: editGate.gateType,
        subType: editGate.subType,
        url: editGate.url,
        settings: editGate.settings || {},
      });
      const data = await res.json();
      setPolishResult(data);
      toast({ title: "AI SUGGESTION READY", description: "Review the polished settings below" });
    } catch (e: any) {
      toast({ title: "POLISH FAILED", description: e.message, variant: "destructive" });
    } finally {
      setPolishing(false);
    }
  };

  // ── Session cache + cooldown visibility
  const { data: sessionData } = useQuery<{ sessions: any[]; cooldowns: any[] }>({
    queryKey: ["/api/sessions"],
    refetchInterval: 15_000,
  });
  const clearSession = async (hostname?: string) => {
    try {
      if (hostname) await apiRequest("DELETE", `/api/sessions/${hostname}`);
      else if (confirm("Clear all cached sessions?")) await apiRequest("DELETE", `/api/sessions`);
      else return;
      queryClient.invalidateQueries({ queryKey: ["/api/sessions"] });
      toast({ title: "SESSION CLEARED", description: hostname || "All hosts" });
    } catch (e: any) {
      toast({ title: "CLEAR FAILED", description: e.message, variant: "destructive" });
    }
  };

  const handleEditSave = () => {
    if (!editGate?.id) return;
    // Strip out undefined / null / empty-string values before saving
    const cleanSettings: Record<string, any> = {};
    for (const [k, v] of Object.entries(editGate.settings || {})) {
      if (v !== undefined && v !== null && v !== "" && v !== "_none_" && (!Array.isArray(v) || v.length > 0)) {
        cleanSettings[k] = v;
      }
    }
    updateGateMutation.mutate({ id: editGate.id, data: {
      name: editGate.name.trim(),
      gateType: editGate.gateType,
      subType: editGate.subType || "standard",
      url: editGate.url.trim(),
      active: editGate.active !== false,
      country: (editGate.country || "").trim().toUpperCase() || null,
      settings: cleanSettings,
    }});
  };

  // Helper to update a settings field; deletes the key when value is empty/null/undefined
  const setEditSetting = (key: string, value: any) => {
    setEditGate((prev: any) => {
      const s = { ...prev.settings };
      if (
        value === undefined ||
        value === null ||
        value === "" ||
        value === "_none_" ||
        (Array.isArray(value) && value.length === 0)
      ) {
        delete s[key];
      } else {
        s[key] = value;
      }
      return { ...prev, settings: s };
    });
  };

  // ── Gate test (run one test card through the gate as currently edited,
  // including any unsaved changes — no need to Save first) ──
  const handleEditTest = async () => {
    if (!editGate?.id) return;
    setEditTesting(true);
    setEditTestResult(null);
    try {
      const cleanUrl = (editGate.url || "").replace(/\/+$/, "");
      const testCard = (editGate.settings?.testCardOverride || "").trim() || "4111111111111111|12|2026|123";
      const res = await apiRequest("POST", "/api/checks", {
        cards: [testCard],
        gateOverride: {
          id: editGate.id,
          name: editGate.name,
          gateType: editGate.gateType,
          subType: editGate.subType || "standard",
          url: cleanUrl,
          // settings.siteUrl is what the checker actually reads — keep it in
          // sync with the Target URL field so unsaved edits are tested faithfully.
          settings: { ...(editGate.settings || {}), siteUrl: cleanUrl || editGate.settings?.siteUrl },
        },
      });
      const results = await res.json();
      if (results?.[0]) {
        setEditTestResult({ status: results[0].status, response: results[0].response, latency: results[0].latency });
      }
    } catch (err: any) {
      setEditTestResult({ status: "error", response: err.message || "Request failed", latency: 0 });
    } finally {
      setEditTesting(false);
    }
  };

  // ── Export gates as JSON ──
  const handleExportGates = useCallback(() => {
    if (gateList.length === 0) {
      toast({ title: "NO GATES", description: "Nothing to export.", variant: "destructive" });
      return;
    }
    const payload = {
      version: "1.0",
      exportedAt: new Date().toISOString(),
      count: gateList.length,
      gates: gateList.map((g: any) => ({
        name: g.name,
        gateType: g.gateType,
        subType: g.subType,
        url: g.url,
        active: g.active,
        settings: g.settings || {},
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `gates_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: "EXPORTED", description: `${gateList.length} gates saved to JSON.` });
  }, [gateList, toast]);

  // ── Import gates from JSON ──
  const importGateMutation = useMutation({
    mutationFn: async (gates: any[]) => {
      const res = await apiRequest("POST", "/api/gates/import", { gates });
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/gates"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
      toast({ title: "IMPORTED", description: `${data.imported} gates imported${data.skipped > 0 ? `, ${data.skipped} skipped (missing fields)` : "."}.` });
    },
    onError: (err: any) => {
      toast({ title: "IMPORT FAILED", description: err.message, variant: "destructive" });
    },
  });

  const handleImportFile = async (file: File) => {
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const gates = Array.isArray(json) ? json : json.gates;
      if (!Array.isArray(gates) || gates.length === 0) {
        toast({ title: "INVALID FILE", description: "JSON must have a 'gates' array.", variant: "destructive" });
        return;
      }
      importGateMutation.mutate(gates);
    } catch {
      toast({ title: "PARSE ERROR", description: "Could not parse JSON file.", variant: "destructive" });
    }
  };

  // ── Import a single gate from a .py checker script or a network-capture
  //    .json/.har file. Step 1: upload → server parses → preview. ──
  const handlePyHarFile = async (file: File) => {
    if (file.size > 8 * 1024 * 1024) {
      toast({ title: "FILE TOO LARGE", description: "Max 8 MB.", variant: "destructive" });
      return;
    }
    setImportParsing(true);
    setImportPreview(null);
    setImportFilename(file.name);
    setImportPyOpen(true);
    try {
      const content = await file.text();
      const res = await apiRequest("POST", "/api/gates/import-source", { filename: file.name, content });
      const parsed = await res.json();
      setImportPreview(parsed);
    } catch (err: any) {
      toast({ title: "PARSE FAILED", description: err?.message || "Could not parse file.", variant: "destructive" });
      setImportPyOpen(false);
    } finally {
      setImportParsing(false);
    }
  };

  const importSourceCommitMutation = useMutation({
    mutationFn: async (gate: any) => {
      const res = await apiRequest("POST", "/api/gates/import-source/commit", gate);
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/gates"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
      toast({ title: "GATE CREATED", description: `"${data.name}" imported and configured.` });
      setImportPyOpen(false);
      setImportPreview(null);
    },
    onError: (err: any) => {
      toast({ title: "CREATE FAILED", description: err?.message || "Could not create gate.", variant: "destructive" });
    },
  });

  // ── Duplicate URL check ──
  const checkDuplicateUrl = (url: string, excludeId?: string): any | null => {
    const target = normaliseUrl(url);
    return gateList.find((g: any) => {
      if (excludeId && g.id === excludeId) return false;
      return normaliseUrl(g.url) === target;
    }) || null;
  };

  const handleBulkSetup = useCallback(async () => {
    let urls = bulkUrls.split("\n").map(u => u.trim()).filter(u => u.length > 3);
    if (urls.length === 0) {
      toast({ title: "NO URLS", description: "Enter at least one URL.", variant: "destructive" });
      return;
    }

    // Deduplicate URLs
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const url of urls) {
      const normalized = normaliseUrl(url);
      if (!seen.has(normalized)) {
        seen.add(normalized);
        deduped.push(url);
      }
    }
    if (deduped.length < urls.length) {
      toast({ title: "DEDUPED", description: `Removed ${urls.length - deduped.length} duplicate URLs.` });
    }
    urls = deduped;

    const initialResults: BulkUrlResult[] = urls.map((url, i) => ({
      index: i, url, status: "pending" as const,
    }));
    setBulkResults(initialResults);
    setBulkScanning(true);
    setBulkCompleted(false);
    setBulkProgress({ current: 0, total: urls.length, configured: 0, failed: 0 });
    setBulkStartTime(Date.now());
    setBulkElapsedLive(0);
    setBulkExpandedIdx(null);

    const controller = new AbortController();
    bulkAbortRef.current = controller;

    try {
      const res = await fetch("/api/gates/bulk-setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls }),
        credentials: "include",
        signal: controller.signal,
      });

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response stream");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));

            if (event.status === "complete") {
              setBulkProgress({ current: event.total, total: event.total, configured: event.configured, failed: event.failed });
              setBulkCompleted(true);
              queryClient.invalidateQueries({ queryKey: ["/api/gates"] });
              queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
              toast({
                title: "MASS SETUP COMPLETE",
                description: `${event.configured}/${event.total} gates configured successfully`,
              });
              continue;
            }

            if (event.index !== undefined) {
              setBulkResults(prev => {
                const next = [...prev];
                next[event.index] = { ...next[event.index], ...event };
                return next;
              });
              if (event.progress) {
                setBulkProgress(event.progress);
              }
            }
          } catch {}
        }
      }
    } catch (err: any) {
      if (err.name !== "AbortError") {
        toast({ title: "MASS SETUP FAILED", description: err.message, variant: "destructive" });
      }
    } finally {
      setBulkScanning(false);
      bulkAbortRef.current = null;
    }
  }, [bulkUrls, toast, queryClient]);

  const handleBulkStop = useCallback(() => {
    bulkAbortRef.current?.abort();
    setBulkScanning(false);
    toast({ title: "STOPPED", description: "Bulk scan aborted." });
  }, [toast]);

  const handleBulkRetryFailed = useCallback(() => {
    const failedUrls = bulkResults.filter(r => r.status === "failed" || r.status === "error").map(r => r.url);
    if (failedUrls.length === 0) return;
    setBulkUrls(failedUrls.join("\n"));
    setBulkResults([]);
    setBulkProgress(null);
  }, [bulkResults]);

  const handleBulkExport = useCallback(() => {
    const successResults = bulkResults.filter(r => r.status === "success");
    if (successResults.length === 0) return;
    const lines = successResults.map(r => {
      const pk = r.publicKey ? ` | PK: ${r.publicKey.slice(0, 25)}...` : "";
      return `${r.gate?.name} | ${r.gate?.gateType} | ${r.gate?.subType} | ${r.url}${pk} | ${r.confidence}%`;
    });
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `gates_bulk_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: "Exported", description: `${successResults.length} gates exported.` });
  }, [bulkResults, toast]);

  const handleBulkPaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setBulkUrls(prev => prev ? prev + "\n" + text : text);
        const newCount = text.split("\n").filter(u => u.trim().length > 3).length;
        toast({ title: "Pasted", description: `${newCount} lines added from clipboard.` });
      }
    } catch {
      toast({ title: "Paste Failed", description: "Could not read clipboard.", variant: "destructive" });
    }
  }, [toast]);

  const handleBulkClear = useCallback(() => {
    setBulkUrls("");
    setBulkResults([]);
    setBulkProgress(null);
    setBulkExpandedIdx(null);
    setBulkStartTime(null);
    setBulkCompleted(false);
    setBulkElapsedLive(0);
  }, []);

  const handleBulkDedup = useCallback(() => {
    const urls = bulkUrls.split("\n").map(u => u.trim()).filter(u => u.length > 3);
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const url of urls) {
      const normalized = normaliseUrl(url);
      if (!seen.has(normalized)) {
        seen.add(normalized);
        deduped.push(url);
      }
    }
    const removed = urls.length - deduped.length;
    setBulkUrls(deduped.join("\n"));
    if (removed > 0) toast({ title: "Cleaned", description: `Removed ${removed} duplicates.` });
    else toast({ title: "No Dupes", description: "All URLs are unique." });
  }, [bulkUrls, toast]);

  const handleAutoDetect = async () => {
    if (!newGate.url) {
      toast({ title: "URL REQUIRED", description: "Enter a target URL first.", variant: "destructive" });
      return;
    }

    setDetecting(true);
    setDetectionResult(null);

    try {
      const res = await apiRequest("POST", "/api/gates/detect-url", { url: newGate.url });
      const result = await res.json();
      setDetectionResult(result);

      if (result.gateType && result.gateType !== "unknown") {
        const domain = result.siteUrl ? new URL(result.siteUrl).hostname.replace(/^www\./, "") : "auto";
        setNewGate(prev => ({
          ...prev,
          gateType: result.gateType,
          subType: result.subType || "standard",
          name: prev.name || `${result.gateType.toUpperCase()}-${domain.split(".")[0].toUpperCase()}`,
          settings: result.settings || {},
        }));
        toast({ title: "DETECTED", description: `${result.gateType.toUpperCase()} gate found (${result.confidence}% confidence, ${result.crawledPaths?.length || 0} paths crawled)` });
      } else {
        toast({ title: "NO GATE DETECTED", description: `Crawled ${result.crawledPaths?.length || 0} paths - no payment gateway found.`, variant: "destructive" });
      }
    } catch (error: any) {
      toast({ title: "DETECTION FAILED", description: error.message, variant: "destructive" });
    } finally {
      setDetecting(false);
    }
  };

  const handleAutoSetup = async () => {
    if (!newGate.url) return;
    const dup = checkDuplicateUrl(newGate.url);
    if (dup) {
      toast({ title: "DUPLICATE URL", description: `Gate "${dup.name}" already uses this URL.`, variant: "destructive" });
      return;
    }
    setDetecting(true);
    try {
      const res = await apiRequest("POST", "/api/gates/auto-setup", { url: newGate.url });
      const data = await res.json();
      queryClient.invalidateQueries({ queryKey: ["/api/gates"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
      setNewGateOpen(false);
      setNewGate({ name: "", gateType: "", subType: "", url: "", settings: {} });
      setDetectionResult(null);
      toast({ title: "AUTO-SETUP COMPLETE", description: `Gate "${data.gate.name}" created with ${data.detection.signals.length} signals` });
    } catch (error: any) {
      toast({ title: "AUTO-SETUP FAILED", description: error.message, variant: "destructive" });
    } finally {
      setDetecting(false);
    }
  };

  const bulkParsedUrls = useMemo(() => bulkUrls.split("\n").map(u => u.trim()).filter(u => u.length > 3), [bulkUrls]);
  const bulkUrlCount = bulkParsedUrls.length;
  const bulkDupeCount = useMemo(() => {
    const seen = new Set<string>();
    let dupes = 0;
    for (const url of bulkParsedUrls) {
      const n = normaliseUrl(url);
      if (seen.has(n)) dupes++;
      else seen.add(n);
    }
    return dupes;
  }, [bulkParsedUrls]);
  const bulkSuccessCount = bulkResults.filter(r => r.status === "success").length;
  const bulkFailedCount = bulkResults.filter(r => r.status === "failed" || r.status === "error").length;

  const formatElapsed = (s: number) => {
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s`;
  };

  const getGateColor = (type: string) => {
    const colors: Record<string, string> = {
      stripe: "border-primary text-primary",
      braintree: "border-[hsl(280_100%_60%)] text-[hsl(280_100%_60%)]",
      payeezy: "border-cyan-400 text-cyan-400",
      paypal: "border-blue-400 text-blue-400",
      square: "border-orange-400 text-orange-400",
      adyen: "border-emerald-400 text-emerald-400",
      authorize_net: "border-yellow-400 text-yellow-400",
      worldpay: "border-red-400 text-red-400",
      checkout_com: "border-indigo-400 text-indigo-400",
      "2checkout": "border-teal-400 text-teal-400",
      klarna: "border-pink-400 text-pink-400",
    };
    return colors[type] || "border-muted-foreground text-muted-foreground";
  };


  return (
    <div className="space-y-6">
      <div className="flex justify-between items-end">
        <div>
          <h2 className="text-3xl font-display font-bold text-foreground glitch-text">System Configuration</h2>
          <p className="text-muted-foreground font-mono mt-1">Bot Management & Multi-Gate Auto-Setup</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="glass-panel rounded-none lg:col-span-1">
          <CardHeader className="border-b border-white/[0.06]">
            <CardTitle className="font-display tracking-widest text-sm flex items-center gap-2">
              <Bot className="w-4 h-4 text-accent" />
              Telegram Bot API
            </CardTitle>
          </CardHeader>
          <CardContent className="p-6 space-y-6">
            <div className="space-y-4 font-mono text-sm">
              <div className="space-y-2">
                <Label className="text-xs uppercase text-muted-foreground">Bot Token</Label>
                <div className="relative">
                  <Input
                    type={showPassword ? "text" : "password"}
                    value={settings?.botToken || ""}
                    onChange={(e) => updateSettingsMutation.mutate({ botToken: e.target.value })}
                    placeholder="1234567890:AAH..."
                    className="bg-background/50 border-white/[0.08] rounded-none focus-visible:ring-accent pr-10"
                    data-testid="input-bot-token"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    data-testid="button-toggle-token-visibility"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <p className="text-[10px] text-muted-foreground">Get from @BotFather on Telegram</p>
              </div>
              <div className="space-y-2">
                <Label className="text-xs uppercase text-muted-foreground">Default Chat ID</Label>
                <Input
                  value={settings?.chatId || ""}
                  onChange={(e) => updateSettingsMutation.mutate({ chatId: e.target.value })}
                  placeholder="-100..."
                  className="bg-background/50 border-white/[0.08] rounded-none focus-visible:ring-accent"
                  data-testid="input-chat-id"
                />
                <p className="text-[10px] text-muted-foreground">Channel/group for proxy outputs & alerts</p>
              </div>
              <div className="space-y-2">
                <Label className="text-xs uppercase text-muted-foreground">Admin / Owner ID</Label>
                <Input
                  value={settings?.ownerId || ""}
                  onChange={(e) => updateSettingsMutation.mutate({ ownerId: e.target.value })}
                  placeholder="User ID"
                  className="bg-background/50 border-white/[0.08] rounded-none focus-visible:ring-accent"
                  data-testid="input-owner-id"
                />
                <p className="text-[10px] text-muted-foreground">Your Telegram user ID (auto-admin)</p>
              </div>
              <div className="space-y-2 pt-2 border-t border-primary/10">
                <Label className="text-xs uppercase text-muted-foreground flex items-center gap-1.5">
                  <Lock className="w-3 h-3" /> Bot Admin Password
                </Label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input
                      type={showAdminPwd ? "text" : "password"}
                      value={adminPwd || settings?.adminPassword || ""}
                      onChange={(e) => { setAdminPwd(e.target.value); setAdminPwdSaved(false); }}
                      placeholder="Admin password"
                      className="bg-background/50 border-white/[0.08] rounded-none focus-visible:ring-accent pr-10"
                      data-testid="input-admin-password"
                    />
                    <button
                      type="button"
                      onClick={() => setShowAdminPwd(!showAdminPwd)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      data-testid="button-toggle-admin-pwd-visibility"
                    >
                      {showAdminPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <Button
                    size="icon"
                    onClick={() => {
                      const pwd = adminPwd || settings?.adminPassword || "926696";
                      updateSettingsMutation.mutate({ adminPassword: pwd });
                      setAdminPwdSaved(true);
                      toast({ title: "SAVED", description: "Admin password updated." });
                      setTimeout(() => setAdminPwdSaved(false), 2000);
                    }}
                    className={`rounded-none h-9 w-9 ${adminPwdSaved ? "bg-primary/20 text-primary border border-primary" : "bg-accent/20 text-accent border border-accent hover:bg-accent hover:text-black"}`}
                    data-testid="button-save-admin-password"
                  >
                    {adminPwdSaved ? <Check className="w-4 h-4" /> : <Save className="w-4 h-4" />}
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground">Used with /login command in Telegram bot</p>
              </div>
            </div>
            <div className="pt-4 border-t border-primary/20 flex flex-col gap-3">
              <div className="flex justify-between items-center text-sm font-mono">
                <span className="text-muted-foreground">Bot Status:</span>
                <span className={settings?.botRunning ? "text-primary font-bold animate-pulse" : "text-destructive font-bold"} data-testid="text-bot-status">
                  {settings?.botRunning ? "RUNNING" : "STOPPED"}
                </span>
              </div>
              <Button
                onClick={() => settings?.botRunning ? stopBotMutation.mutate() : startBotMutation.mutate()}
                disabled={startBotMutation.isPending || stopBotMutation.isPending}
                className={`w-full rounded-none font-display font-bold tracking-widest transition-all duration-300 ${
                  settings?.botRunning
                    ? "bg-destructive/20 text-destructive border border-destructive hover:bg-destructive hover:text-black"
                    : "bg-primary text-black hover:bg-primary/90 shadow-[0_0_10px_rgba(0,255,128,0.2)]"
                }`}
                data-testid="button-toggle-bot"
              >
                {(startBotMutation.isPending || stopBotMutation.isPending) ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : settings?.botRunning ? (
                  <><Square className="w-4 h-4 mr-2" /> STOP POLLING</>
                ) : (
                  <><Play className="w-4 h-4 mr-2" /> START BOT</>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="glass-panel rounded-none lg:col-span-2">
          <CardHeader className="border-b border-white/[0.06] flex flex-row items-center justify-between">
            <div>
              <CardTitle className="font-display tracking-widest text-sm flex items-center gap-2">
                <Settings className="w-4 h-4 text-primary" />
                Gate Configurations
                {gateList.length > 0 && (
                  <span className="ml-1 px-2 py-0.5 text-[10px] font-mono bg-primary/10 text-primary border border-primary/20">{gateList.length}</span>
                )}
              </CardTitle>
              <CardDescription className="font-mono text-xs mt-1">
                {gateList.length === 0
                  ? "No gates yet. Scan sites with MASS SETUP or add manually with NEW CONFIG."
                  : `${gateList.filter((g: any) => g.active).length}/${gateList.length} active · Deep-crawl auto-detect · Stripe, Braintree, PayPal`}
              </CardDescription>
            </div>
            <div className="flex gap-2 flex-wrap">
              {/* Import / Export */}
              <Button
                variant="outline"
                size="sm"
                onClick={handleExportGates}
                disabled={gateList.length === 0}
                className="rounded-none border-white/[0.08] text-primary hover:bg-primary/10 font-mono text-[10px] h-8 px-2"
                title="Export all gates as JSON"
              >
                <Download className="w-3 h-3 mr-1" /> EXPORT
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => importFileRef.current?.click()}
                disabled={importGateMutation.isPending}
                className="rounded-none border-accent/30 text-accent hover:bg-accent/10 font-mono text-[10px] h-8 px-2"
                title="Import gates from JSON backup"
              >
                {importGateMutation.isPending
                  ? <Loader2 className="w-3 h-3 animate-spin mr-1" />
                  : <Upload className="w-3 h-3 mr-1" />}
                IMPORT
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => pyHarFileRef.current?.click()}
                disabled={importParsing}
                className="rounded-none border-purple-500/40 text-purple-400 hover:bg-purple-500/10 font-mono text-[10px] h-8 px-2"
                title="Import a gate from a .py checker script or a network-capture .json/.har file"
              >
                {importParsing
                  ? <Loader2 className="w-3 h-3 animate-spin mr-1" />
                  : <Cpu className="w-3 h-3 mr-1" />}
                FROM .PY / .HAR
              </Button>
              <input
                ref={pyHarFileRef}
                type="file"
                accept=".py,.json,.har,.txt"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handlePyHarFile(f); e.target.value = ""; }}
              />

              {/* Parsed-preview dialog for .py / .har imports */}
              <Dialog open={importPyOpen} onOpenChange={(open) => { setImportPyOpen(open); if (!open) setImportPreview(null); }}>
                <DialogContent className="bg-background border-purple-500/30 max-w-2xl max-h-[92vh] overflow-y-auto p-0">
                  <div className="shrink-0 border-b border-white/[0.06] px-6 py-4">
                    <DialogTitle className="font-display tracking-widest text-base flex items-center gap-2 text-purple-300">
                      <Cpu className="w-5 h-5" /> IMPORT GATE FROM SOURCE
                    </DialogTitle>
                    <p className="font-mono text-[11px] text-muted-foreground mt-1">
                      {importFilename ? `Parsed: ${importFilename}` : "Parsing…"}
                    </p>
                  </div>

                  <div className="p-6 space-y-4">
                    {importParsing && (
                      <div className="flex items-center gap-2 text-sm font-mono text-muted-foreground py-8 justify-center">
                        <Loader2 className="w-4 h-4 animate-spin" /> Parsing source…
                      </div>
                    )}

                    {!importParsing && importPreview && (
                      <>
                        {/* Confidence */}
                        <div className="flex items-center gap-3">
                          <span className="font-mono text-[10px] uppercase text-muted-foreground/60 w-24">Confidence</span>
                          <div className="flex-1 h-2 bg-muted/30 overflow-hidden">
                            <div
                              className={`h-full ${importPreview.confidence >= 0.7 ? "bg-green-500" : importPreview.confidence >= 0.4 ? "bg-yellow-500" : "bg-red-500"}`}
                              style={{ width: `${Math.round((importPreview.confidence || 0) * 100)}%` }}
                            />
                          </div>
                          <span className="font-mono text-xs">{Math.round((importPreview.confidence || 0) * 100)}%</span>
                          <span className="font-mono text-[10px] px-2 py-0.5 border border-purple-500/30 text-purple-300 uppercase">{importPreview.source}</span>
                        </div>

                        {/* Warnings */}
                        {Array.isArray(importPreview.warnings) && importPreview.warnings.length > 0 && (
                          <div className="border border-yellow-500/30 bg-yellow-500/5 p-3 space-y-1">
                            {importPreview.warnings.map((w: string, i: number) => (
                              <div key={i} className="flex items-start gap-2 text-[11px] font-mono text-yellow-300/90">
                                <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" /> {w}
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Editable core fields */}
                        <div className="grid grid-cols-2 gap-3">
                          <div className="col-span-2">
                            <Label className="text-[10px] font-mono uppercase text-muted-foreground/60">Gate Name</Label>
                            <Input
                              value={importPreview.name || ""}
                              onChange={(e) => setImportPreview((p: any) => ({ ...p, name: e.target.value }))}
                              className="rounded-none font-mono text-sm h-8 mt-1"
                            />
                          </div>
                          <div>
                            <Label className="text-[10px] font-mono uppercase text-muted-foreground/60">Gate Type</Label>
                            <Select value={importPreview.gateType} onValueChange={(v) => setImportPreview((p: any) => ({ ...p, gateType: v }))}>
                              <SelectTrigger className="rounded-none font-mono text-sm h-8 mt-1"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {["stripe", "shopify", "braintree", "paypal", "payeezy", "unknown"].map(t => (
                                  <SelectItem key={t} value={t} className="font-mono text-xs">{t.toUpperCase()}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div>
                            <Label className="text-[10px] font-mono uppercase text-muted-foreground/60">Sub-Type</Label>
                            <Select value={importPreview.subType || "standard"} onValueChange={(v) => setImportPreview((p: any) => ({ ...p, subType: v }))}>
                              <SelectTrigger className="rounded-none font-mono text-sm h-8 mt-1"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="standard" className="font-mono text-xs">standard (WC / admin-ajax)</SelectItem>
                                <SelectItem value="charges" className="font-mono text-xs">charges</SelectItem>
                                <SelectItem value="payment_intents" className="font-mono text-xs">payment_intents</SelectItem>
                                <SelectItem value="givewp" className="font-mono text-xs">givewp</SelectItem>
                                <SelectItem value="givewp_v3" className="font-mono text-xs">givewp_v3</SelectItem>
                                <SelectItem value="charitable" className="font-mono text-xs">charitable</SelectItem>
                                <SelectItem value="gravityforms" className="font-mono text-xs">gravityforms</SelectItem>
                                <SelectItem value="wp_full_stripe" className="font-mono text-xs">wp_full_stripe (Mammothology)</SelectItem>
                                <SelectItem value="auth" className="font-mono text-xs">auth (setup_intent)</SelectItem>
                                <SelectItem value="checkout_session" className="font-mono text-xs">checkout_session</SelectItem>
                                <SelectItem value="stripe_page_confirm" className="font-mono text-xs">stripe_page_confirm</SelectItem>
                                <SelectItem value="pci" className="font-mono text-xs">pci (Shopify PCI checkout)</SelectItem>
                                <SelectItem value="bigcommerce_stencil" className="font-mono text-xs">bigcommerce_stencil</SelectItem>
                                <SelectItem value="givewp_commerce" className="font-mono text-xs">givewp_commerce (PayPal)</SelectItem>
                                <SelectItem value="paypal_commerce" className="font-mono text-xs">paypal_commerce (PayPal)</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="col-span-2">
                            <Label className="text-[10px] font-mono uppercase text-muted-foreground/60">Target URL</Label>
                            <Input
                              value={importPreview.url || ""}
                              onChange={(e) => setImportPreview((p: any) => ({ ...p, url: e.target.value, settings: { ...p.settings, siteUrl: e.target.value } }))}
                              placeholder="https://example.com"
                              className="rounded-none font-mono text-sm h-8 mt-1"
                            />
                          </div>
                        </div>

                        {/* Extracted settings preview */}
                        <div>
                          <Label className="text-[10px] font-mono uppercase text-muted-foreground/60 mb-1 block">Extracted Settings</Label>
                          <div className="border border-white/[0.06] bg-muted/10 p-3 space-y-1 max-h-52 overflow-y-auto">
                            {Object.entries(importPreview.settings || {})
                              .filter(([k]) => !["classificationKeys", "autoDetected", "importedAt", "importedFrom"].includes(k))
                              .map(([k, v]) => (
                                <div key={k} className="grid grid-cols-[140px_1fr] gap-2 text-[11px] font-mono items-start">
                                  <span className="text-purple-300/80 truncate">{k}</span>
                                  <span className="text-foreground/90 break-all">
                                    {Array.isArray(v) ? `[${v.length}] ${(v as string[]).slice(0, 4).join(", ")}${(v as any[]).length > 4 ? "…" : ""}`
                                      : typeof v === "object" ? JSON.stringify(v)
                                      : String(v)}
                                  </span>
                                </div>
                              ))}
                            {Object.keys(importPreview.settings || {}).length === 0 && (
                              <span className="text-[11px] font-mono text-muted-foreground">No settings extracted.</span>
                            )}
                          </div>
                        </div>

                        {/* Classification key buckets */}
                        {importPreview.classification && Object.keys(importPreview.classification).length > 0 && (
                          <div>
                            <Label className="text-[10px] font-mono uppercase text-muted-foreground/60 mb-1 block">
                              Classification Keys ({Object.keys(importPreview.classification).length} buckets)
                            </Label>
                            <div className="border border-white/[0.06] bg-muted/10 p-3 max-h-32 overflow-y-auto space-y-0.5">
                              {Object.entries(importPreview.classification).map(([bucket, keys]: any) => (
                                <div key={bucket} className="text-[10px] font-mono">
                                  <span className="text-cyan-400/80">{bucket}</span>
                                  <span className="text-muted-foreground/60"> ({keys.length})</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        <div className="flex gap-2 pt-2">
                          <Button
                            onClick={() => importSourceCommitMutation.mutate(importPreview)}
                            disabled={importSourceCommitMutation.isPending || !importPreview.name || !importPreview.gateType}
                            className="rounded-none bg-purple-500/20 text-purple-200 border border-purple-500 hover:bg-purple-500 hover:text-black font-mono text-xs h-9 flex-1"
                          >
                            {importSourceCommitMutation.isPending
                              ? <><Loader2 className="w-3 h-3 animate-spin mr-1" /> CREATING…</>
                              : <><Plus className="w-3 h-3 mr-1" /> CREATE GATE</>}
                          </Button>
                          <Button
                            variant="outline"
                            onClick={() => { setImportPyOpen(false); setImportPreview(null); }}
                            className="rounded-none border-muted-foreground/30 font-mono text-xs h-9"
                          >
                            CANCEL
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                </DialogContent>
              </Dialog>

              <Button
                variant="outline"
                size="sm"
                onClick={handleRedetectAll}
                disabled={redetecting.running || gateList.length === 0}
                className="rounded-none border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10 font-mono text-[10px] h-8 px-2"
                title="Re-run gate-detector on every configured gate"
              >
                {redetecting.running
                  ? <><Loader2 className="w-3 h-3 animate-spin mr-1" /> {redetecting.done}/{redetecting.total}</>
                  : <><RefreshCw className="w-3 h-3 mr-1" /> RE-DETECT ALL</>}
              </Button>
              <input
                ref={importFileRef}
                type="file"
                accept=".json"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImportFile(f); e.target.value = ""; }}
              />

              <Dialog open={bulkOpen} onOpenChange={(open) => {
                setBulkOpen(open);
                if (!open && !bulkScanning) {
                  setBulkResults([]);
                  setBulkProgress(null);
                  setBulkExpandedIdx(null);
                  setBulkStartTime(null);
                  setBulkCompleted(false);
                  setBulkElapsedLive(0);
                }
              }}>
                <DialogTrigger asChild>
                  <Button className="rounded-none bg-accent/20 text-accent border border-accent hover:bg-accent hover:text-black font-mono text-xs h-8" data-testid="button-bulk-setup">
                    <Radar className="w-3 h-3 mr-1" /> MASS SETUP
                  </Button>
                </DialogTrigger>
                <DialogContent className="bg-background border-white/[0.08] max-w-3xl max-h-[92vh] overflow-hidden flex flex-col p-0">
                  {/* Header */}
                  <div className="shrink-0 border-b border-white/[0.06] px-6 py-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 border border-accent/50 bg-accent/10 flex items-center justify-center">
                          <Radar className={`w-4 h-4 text-accent ${bulkScanning ? "animate-spin" : ""}`} />
                        </div>
                        <div>
                          <h3 className="font-display tracking-widest text-base font-bold flex items-center gap-2">
                            Mass URL Gate Setup
                            {bulkScanning && <span className="text-[10px] font-mono text-accent bg-accent/10 px-1.5 py-0.5 border border-accent/30 animate-pulse">LIVE</span>}
                            {bulkCompleted && !bulkScanning && <span className="text-[10px] font-mono text-emerald-400 bg-emerald-400/10 px-1.5 py-0.5 border border-emerald-400/30">DONE</span>}
                          </h3>
                          <p className="text-[10px] font-mono text-muted-foreground mt-0.5">
                            Deep-crawl sites to extract Stripe keys, BT tokens, nonces, donation forms & CAPTCHAs
                          </p>
                        </div>
                      </div>
                      {bulkScanning && (
                        <div className="text-right">
                          <div className="text-lg font-mono font-bold text-accent tabular-nums">{formatElapsed(bulkElapsedLive)}</div>
                          <div className="text-[10px] font-mono text-muted-foreground/60">ELAPSED</div>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
                    {/* URL Input Section */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs font-mono uppercase text-muted-foreground flex items-center gap-1.5">
                          <Globe className="w-3 h-3" /> TARGET URLS
                        </Label>
                        <div className="flex items-center gap-2">
                          {bulkDupeCount > 0 && (
                            <button onClick={handleBulkDedup} className="text-[10px] font-mono text-yellow-400/70 hover:text-yellow-400 flex items-center gap-1 transition-colors">
                              <AlertTriangle className="w-2.5 h-2.5" /> {bulkDupeCount} dupes
                            </button>
                          )}
                          <span className="text-[10px] font-mono text-muted-foreground tabular-nums">
                            {bulkUrlCount} {bulkUrlCount === 1 ? "site" : "sites"}
                          </span>
                        </div>
                      </div>
                      <div className="relative">
                        <Textarea
                          value={bulkUrls}
                          onChange={(e) => setBulkUrls(e.target.value)}
                          placeholder={"# Paste domains or full URLs, one per line\nsimplygreatdeals.co.uk\non8mil.com\nrainbows-uniform.co.uk\ngofrolic.co.uk\nexample-donations.org/donate\nhttps://shop.example.com/checkout"}
                          className="rounded-none border-white/[0.08] font-mono text-xs min-h-[120px] resize-none bg-white/[0.03] pr-12"
                          disabled={bulkScanning}
                          data-testid="input-bulk-urls"
                        />
                        {/* Side toolbar */}
                        <div className="absolute top-1 right-1 flex flex-col gap-0.5">
                          <button
                            onClick={handleBulkPaste}
                            disabled={bulkScanning}
                            className="p-1.5 text-muted-foreground/40 hover:text-primary hover:bg-primary/10 transition-colors disabled:opacity-30"
                            title="Paste from clipboard"
                          >
                            <ClipboardPaste className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={handleBulkClear}
                            disabled={bulkScanning || !bulkUrls}
                            className="p-1.5 text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-30"
                            title="Clear all"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground/50">
                        <span className="flex items-center gap-1"><Globe className="w-2.5 h-2.5" /> Domains or full URLs</span>
                        <span className="text-primary/30">|</span>
                        <span className="flex items-center gap-1"><Search className="w-2.5 h-2.5" /> Crawls 30+ paths per site</span>
                        <span className="text-primary/30">|</span>
                        <span className="flex items-center gap-1"><Key className="w-2.5 h-2.5" /> Extracts keys & tokens</span>
                      </div>
                    </div>

                    {/* Action Buttons */}
                    <div className="flex gap-2">
                      {!bulkScanning ? (
                        <Button
                          onClick={handleBulkSetup}
                          disabled={bulkUrlCount === 0}
                          className="flex-1 rounded-none bg-accent/20 text-accent border border-accent hover:bg-accent hover:text-black font-display tracking-widest text-xs h-10 shadow-[0_0_15px_rgba(var(--accent-rgb),0.15)]"
                          data-testid="button-start-bulk"
                        >
                          <Radar className="w-4 h-4 mr-2" /> SCAN & CONFIGURE {bulkUrlCount > 0 && `(${bulkUrlCount} sites)`}
                        </Button>
                      ) : (
                        <Button
                          onClick={handleBulkStop}
                          className="flex-1 rounded-none bg-destructive/20 text-destructive border border-destructive hover:bg-destructive hover:text-black font-display tracking-widest text-xs h-10"
                          data-testid="button-stop-bulk"
                        >
                          <Square className="w-4 h-4 mr-2" /> ABORT SCAN
                        </Button>
                      )}
                    </div>

                    {/* Progress Section */}
                    {bulkProgress && (
                      <div className="space-y-3 border border-primary/10 bg-white/[0.02] p-4">
                        {/* Progress bar */}
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between text-xs font-mono">
                            <span className="text-muted-foreground flex items-center gap-1.5">
                              {bulkScanning ? (
                                <><Loader2 className="w-3 h-3 animate-spin text-accent" /> Scanning {bulkProgress.current}/{bulkProgress.total}</>
                              ) : (
                                <><CheckCircle className="w-3 h-3 text-emerald-400" /> Scan complete</>
                              )}
                            </span>
                            <span className="text-primary font-bold tabular-nums">
                              {bulkProgress.total > 0 ? ((bulkProgress.current / bulkProgress.total) * 100).toFixed(0) : 0}%
                            </span>
                          </div>
                          <div className="w-full bg-primary/10 h-2 overflow-hidden">
                            <div
                              className="h-2 transition-all duration-500 ease-out relative"
                              style={{
                                width: `${bulkProgress.total > 0 ? (bulkProgress.current / bulkProgress.total) * 100 : 0}%`,
                                background: `linear-gradient(90deg, hsl(var(--primary)) 0%, hsl(var(--accent)) 100%)`
                              }}
                            >
                              {bulkScanning && (
                                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-pulse" />
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Stats grid */}
                        <div className="grid grid-cols-4 gap-2">
                          <div className="border border-emerald-500/20 bg-emerald-500/5 p-2 text-center">
                            <div className="text-emerald-400 font-bold text-xl font-mono tabular-nums" data-testid="text-bulk-success">{bulkProgress.configured}</div>
                            <div className="text-emerald-400/60 text-[9px] font-mono uppercase tracking-wider">Configured</div>
                          </div>
                          <div className="border border-red-500/20 bg-red-500/5 p-2 text-center">
                            <div className="text-red-400 font-bold text-xl font-mono tabular-nums" data-testid="text-bulk-failed">{bulkProgress.failed}</div>
                            <div className="text-red-400/60 text-[9px] font-mono uppercase tracking-wider">Failed</div>
                          </div>
                          <div className="border border-cyan-500/20 bg-cyan-500/5 p-2 text-center">
                            <div className="text-cyan-400 font-bold text-xl font-mono tabular-nums">{bulkKeysFound}</div>
                            <div className="text-cyan-400/60 text-[9px] font-mono uppercase tracking-wider">Keys Found</div>
                          </div>
                          <div className="border border-purple-500/20 bg-purple-500/5 p-2 text-center">
                            <div className="text-purple-400 font-bold text-xl font-mono tabular-nums">{bulkProgress.total - bulkProgress.current}</div>
                            <div className="text-purple-400/60 text-[9px] font-mono uppercase tracking-wider">Remaining</div>
                          </div>
                        </div>

                        {/* Gate type distribution */}
                        {Object.keys(bulkGateTypeDist).length > 0 && (
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">Types:</span>
                            {Object.entries(bulkGateTypeDist).map(([type, count]) => (
                              <span key={type} className={`px-1.5 py-0.5 text-[10px] font-mono border ${getGateColor(type)} bg-white/[0.03]`}>
                                {type.toUpperCase()} x{count}
                              </span>
                            ))}
                            {bulkAvgConfidence > 0 && (
                              <span className="text-[10px] font-mono text-muted-foreground/50 ml-auto flex items-center gap-1">
                                <Activity className="w-2.5 h-2.5" /> Avg: {bulkAvgConfidence}%
                              </span>
                            )}
                          </div>
                        )}

                        {/* Completion summary */}
                        {bulkCompleted && !bulkScanning && (
                          <div className="border-t border-primary/10 pt-3 flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              <div className="flex items-center gap-1 text-xs font-mono text-muted-foreground">
                                <Clock className="w-3 h-3" /> {formatElapsed(bulkElapsedLive)}
                              </div>
                              <div className="flex items-center gap-1 text-xs font-mono text-muted-foreground">
                                <Database className="w-3 h-3" /> {bulkProgress.configured} gates saved
                              </div>
                            </div>
                            <div className="flex gap-1.5">
                              {bulkFailedCount > 0 && (
                                <Button
                                  onClick={handleBulkRetryFailed}
                                  variant="outline"
                                  size="sm"
                                  className="rounded-none border-yellow-500/30 text-yellow-400 hover:bg-yellow-500/10 font-mono text-[10px] h-7 px-2"
                                  data-testid="button-retry-failed"
                                >
                                  <RotateCcw className="w-3 h-3 mr-1" /> Retry {bulkFailedCount} failed
                                </Button>
                              )}
                              {bulkSuccessCount > 0 && (
                                <>
                                  <Button
                                    onClick={() => {
                                      const keys = bulkResults
                                        .filter(r => r.status === "success" && r.publicKey)
                                        .map(r => `${r.gate?.name}: ${r.publicKey}`)
                                        .join("\n");
                                      if (keys) {
                                        navigator.clipboard.writeText(keys);
                                        toast({ title: "Copied", description: `${bulkKeysFound} keys copied.` });
                                      }
                                    }}
                                    variant="outline"
                                    size="sm"
                                    className="rounded-none border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10 font-mono text-[10px] h-7 px-2"
                                  >
                                    <Copy className="w-3 h-3 mr-1" /> Keys
                                  </Button>
                                  <Button
                                    onClick={handleBulkExport}
                                    variant="outline"
                                    size="sm"
                                    className="rounded-none border-white/[0.08] text-primary hover:bg-primary/10 font-mono text-[10px] h-7 px-2"
                                    data-testid="button-export-bulk"
                                  >
                                    <Download className="w-3 h-3 mr-1" /> Export
                                  </Button>
                                </>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Results List */}
                    {bulkResults.length > 0 && (
                      <div className="space-y-1">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
                            <Layers className="w-3 h-3" /> SCAN RESULTS ({bulkResults.length})
                          </span>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => setBulkAutoScroll(!bulkAutoScroll)}
                              className={`p-1 transition-colors ${bulkAutoScroll ? "text-cyan-400" : "text-muted-foreground/30"}`}
                              title={bulkAutoScroll ? "Auto-scroll ON" : "Auto-scroll OFF"}
                            >
                              <ArrowDownToLine className="w-3 h-3" />
                            </button>
                            {bulkSuccessCount > 0 && (
                              <button
                                onClick={() => setBulkExpandedIdx(bulkExpandedIdx === -999 ? null : -999)}
                                className="text-[10px] font-mono text-muted-foreground/50 hover:text-muted-foreground flex items-center gap-1 transition-colors"
                                title="Toggle all expanded"
                              >
                                {bulkExpandedIdx === -999 ? <ArrowUpToLine className="w-3 h-3" /> : <ArrowDownToLine className="w-3 h-3" />}
                              </button>
                            )}
                          </div>
                        </div>
                        <div ref={bulkScrollRef} className="border border-primary/10 max-h-[340px] overflow-y-auto custom-scrollbar bg-white/[0.02]">
                          {bulkResults.map((r, i) => {
                            const isExpanded = bulkExpandedIdx === i || bulkExpandedIdx === -999;
                            const statusIcon = r.status === "success" ? <CheckCircle className="w-3.5 h-3.5 text-emerald-400 shrink-0" /> :
                              r.status === "failed" || r.status === "error" ? <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" /> :
                              r.status === "scanning" ? <Loader2 className="w-3.5 h-3.5 text-accent animate-spin shrink-0" /> :
                              r.status === "skipped" ? <AlertTriangle className="w-3.5 h-3.5 text-yellow-400 shrink-0" /> :
                              <div className="w-3.5 h-3.5 border border-muted-foreground/20 shrink-0" />;

                            return (
                              <div key={i} className={`border-b border-primary/5 transition-all duration-200 ${
                                r.status === "success" ? "hover:bg-emerald-500/5" :
                                r.status === "failed" || r.status === "error" ? "hover:bg-red-500/5" :
                                r.status === "scanning" ? "bg-accent/5 border-l-2 border-l-accent" :
                                "hover:bg-white/[0.03]"
                              }`}>
                                {/* Row header */}
                                <div
                                  className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none"
                                  onClick={() => setBulkExpandedIdx(isExpanded && bulkExpandedIdx !== -999 ? null : i)}
                                >
                                  <span className="text-[10px] font-mono text-muted-foreground/30 w-5 text-right tabular-nums shrink-0">{i + 1}</span>
                                  {statusIcon}
                                  <span className="font-mono text-xs text-foreground/80 truncate flex-1 min-w-0">{r.url}</span>

                                  {r.status === "success" && (
                                    <div className="flex items-center gap-1.5 shrink-0">
                                      <span className={`px-1.5 py-0.5 text-[10px] font-mono border ${getGateColor(r.gate?.gateType || "")}`}>
                                        {r.gate?.gateType?.toUpperCase()}
                                      </span>
                                      <span className="text-[10px] font-mono text-accent px-1 py-0.5 bg-accent/10 border border-accent/20">
                                        {(r.subType || r.gate?.subType || "std").replace(/_/g, " ").toUpperCase()}
                                      </span>
                                      {r.publicKey && (
                                        <span className="text-[10px] font-mono text-primary flex items-center gap-0.5 bg-primary/10 px-1 py-0.5 border border-primary/20">
                                          <Key className="w-2.5 h-2.5" /> KEY
                                        </span>
                                      )}
                                      {r.btToken && (
                                        <span className="text-[10px] font-mono text-purple-400 flex items-center gap-0.5 bg-purple-400/10 px-1 py-0.5 border border-purple-400/20">
                                          <Key className="w-2.5 h-2.5" /> BT
                                        </span>
                                      )}
                                      <div className="flex items-center gap-1">
                                        <span className="text-[10px] font-mono text-muted-foreground tabular-nums">{r.confidence}%</span>
                                        <div className="w-10 h-1.5 bg-primary/10 overflow-hidden">
                                          <div
                                            className={`h-1.5 transition-all ${
                                              (r.confidence || 0) >= 70 ? "bg-emerald-400" :
                                              (r.confidence || 0) >= 40 ? "bg-yellow-400" : "bg-red-400"
                                            }`}
                                            style={{ width: `${Math.min(r.confidence || 0, 100)}%` }}
                                          />
                                        </div>
                                      </div>
                                      <ChevronRight className={`w-3 h-3 text-muted-foreground/30 transition-transform duration-200 ${isExpanded ? "rotate-90" : ""}`} />
                                    </div>
                                  )}

                                  {(r.status === "failed" || r.status === "error") && (
                                    <div className="flex items-center gap-1.5 shrink-0">
                                      <span className="text-[10px] font-mono text-red-400/70 max-w-[160px] truncate">{r.reason}</span>
                                      {r.signals && r.signals.length > 0 && (
                                        <ChevronRight className={`w-3 h-3 text-muted-foreground/30 transition-transform duration-200 ${isExpanded ? "rotate-90" : ""}`} />
                                      )}
                                    </div>
                                  )}

                                  {r.status === "scanning" && (
                                    <div className="flex items-center gap-1.5 shrink-0">
                                      <span className="text-[10px] font-mono text-accent animate-pulse">Deep crawling...</span>
                                      <div className="flex gap-0.5">
                                        <div className="w-1 h-3 bg-accent/30 animate-pulse" style={{ animationDelay: "0ms" }} />
                                        <div className="w-1 h-3 bg-accent/50 animate-pulse" style={{ animationDelay: "150ms" }} />
                                        <div className="w-1 h-3 bg-accent/70 animate-pulse" style={{ animationDelay: "300ms" }} />
                                      </div>
                                    </div>
                                  )}

                                  {r.status === "pending" && (
                                    <span className="text-[10px] font-mono text-muted-foreground/30 shrink-0">Queued</span>
                                  )}
                                </div>

                                {/* Expanded details */}
                                {isExpanded && (r.status === "success" || (r.signals && r.signals.length > 0)) && (
                                  <div className="px-4 pb-3 ml-9 space-y-2.5 border-t border-primary/5 bg-white/[0.03]">
                                    {/* Gate info row */}
                                    {r.gate && (
                                      <div className="flex flex-wrap gap-x-4 gap-y-1.5 pt-2.5">
                                        <div className="flex items-center gap-1.5 text-[10px] font-mono">
                                          <Database className="w-3 h-3 text-muted-foreground/40" />
                                          <span className="text-muted-foreground">Name:</span>
                                          <span className="text-foreground font-bold">{r.gate.name}</span>
                                        </div>
                                        <div className="flex items-center gap-1.5 text-[10px] font-mono">
                                          <span className="text-muted-foreground">Type:</span>
                                          <span className={`font-bold ${getGateColor(r.gate.gateType)}`}>{r.gate.gateType.toUpperCase()}</span>
                                        </div>
                                        <div className="flex items-center gap-1.5 text-[10px] font-mono">
                                          <span className="text-muted-foreground">Sub:</span>
                                          <span className="text-accent font-bold">{(r.subType || r.gate.subType || "standard").replace(/_/g, " ").toUpperCase()}</span>
                                        </div>
                                        <div className="flex items-center gap-1.5 text-[10px] font-mono">
                                          <span className="text-muted-foreground">Confidence:</span>
                                          <span className={`font-bold ${
                                            (r.confidence || 0) >= 70 ? "text-emerald-400" :
                                            (r.confidence || 0) >= 40 ? "text-yellow-400" : "text-red-400"
                                          }`}>{r.confidence}%</span>
                                        </div>
                                        <div className="flex items-center gap-1.5 text-[10px] font-mono">
                                          <span className="text-muted-foreground">Crawled:</span>
                                          <span className="text-foreground/60">{r.crawledPaths} paths</span>
                                        </div>
                                      </div>
                                    )}

                                    {/* Public key */}
                                    {r.publicKey && (
                                      <div className="flex items-center gap-2 bg-white/[0.02] border border-primary/10 p-2">
                                        <Key className="w-3.5 h-3.5 text-primary shrink-0" />
                                        <code className="text-[10px] font-mono text-primary flex-1 break-all select-all">{r.publicKey}</code>
                                        <button
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            navigator.clipboard.writeText(r.publicKey || "");
                                            toast({ title: "Copied", description: "Key copied." });
                                          }}
                                          className="text-muted-foreground hover:text-primary transition-colors shrink-0 p-1"
                                        >
                                          <Copy className="w-3 h-3" />
                                        </button>
                                      </div>
                                    )}

                                    {/* Signals */}
                                    {r.signals && r.signals.length > 0 && (
                                      <div className="space-y-1">
                                        <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/40 flex items-center gap-1">
                                          <Sparkles className="w-2.5 h-2.5" /> {r.signals.length} DETECTION SIGNALS
                                        </span>
                                        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                                          {r.signals.map((sig, si) => (
                                            <div key={si} className="text-[10px] font-mono text-muted-foreground/70 flex items-start gap-1">
                                              <span className={`shrink-0 mt-0.5 ${sig.startsWith("⚠") ? "text-yellow-400" : "text-primary/60"}`}>
                                                {sig.startsWith("⚠") ? "!" : "+"}
                                              </span>
                                              <span className="break-all">{sig}</span>
                                            </div>
                                          ))}
                                        </div>
                                      </div>
                                    )}

                                    {/* Auto-configured settings */}
                                    {r.settings && Object.entries(r.settings).filter(([k]) => !["autoDetected", "subtypes", "siteUrl", "publicKey"].includes(k)).length > 0 && (
                                      <div className="space-y-1">
                                        <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/40 flex items-center gap-1">
                                          <Settings className="w-2.5 h-2.5" /> AUTO-CONFIGURED
                                        </span>
                                        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                                          {Object.entries(r.settings).filter(([k]) => !["autoDetected", "subtypes", "siteUrl", "publicKey"].includes(k)).map(([key, val]) => (
                                            <div key={key} className="text-[10px] font-mono flex items-start gap-1">
                                              <span className="text-accent/70 shrink-0">{key}:</span>
                                              <span className="text-foreground/50 break-all">
                                                {typeof val === "boolean" ? (val ? "true" : "false") :
                                                 typeof val === "object" ? JSON.stringify(val).slice(0, 60) :
                                                 String(val).length > 50 ? String(val).slice(0, 50) + "..." : String(val)}
                                              </span>
                                            </div>
                                          ))}
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </DialogContent>
              </Dialog>

              <Dialog open={newGateOpen} onOpenChange={(open) => {
                setNewGateOpen(open);
                if (!open) { setDetectionResult(null); setNewGate({ name: "", gateType: "", subType: "", url: "", settings: {} }); }
              }}>
                <DialogTrigger asChild>
                  <Button className="rounded-none bg-primary text-black hover:bg-primary/90 font-mono text-xs h-8" data-testid="button-new-gate">
                    <Plus className="w-3 h-3 mr-1" /> NEW CONFIG
                  </Button>
                </DialogTrigger>
                <DialogContent className="bg-background border-white/[0.08] max-w-lg">
                  <DialogHeader>
                    <DialogTitle className="font-display tracking-widest">New Gate Configuration</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label className="text-xs font-mono uppercase text-muted-foreground">Target URL / Domain</Label>
                      <div className="flex gap-2">
                        <Input
                          value={newGate.url}
                          onChange={(e) => setNewGate(prev => ({ ...prev, url: e.target.value }))}
                          placeholder="example.co.uk or https://example.com/checkout"
                          className="rounded-none border-white/[0.08] font-mono flex-1"
                          data-testid="input-gate-url"
                        />
                      </div>
                      <div className="flex gap-2">
                        <Button
                          onClick={handleAutoDetect}
                          disabled={detecting || !newGate.url}
                          className="flex-1 rounded-none bg-accent/20 text-accent border border-accent hover:bg-accent hover:text-black font-mono text-xs"
                          data-testid="button-auto-detect"
                        >
                          {detecting ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Search className="w-3 h-3 mr-1" />}
                          DETECT ONLY
                        </Button>
                        <Button
                          onClick={handleAutoSetup}
                          disabled={detecting || !newGate.url}
                          className="flex-1 rounded-none bg-primary text-black hover:bg-primary/90 font-mono text-xs"
                          data-testid="button-auto-setup"
                        >
                          {detecting ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Zap className="w-3 h-3 mr-1" />}
                          AUTO-SETUP
                        </Button>
                      </div>
                    </div>

                    {detectionResult && (
                      <div className={`border p-3 space-y-2 ${detectionResult.gateType !== "unknown" ? "border-white/[0.08] bg-white/[0.02]" : "border-destructive/30 bg-destructive/5"}`}>
                        <div className="flex items-center gap-2">
                          <Shield className="w-4 h-4 text-accent" />
                          <span className="font-mono text-xs font-bold text-accent uppercase">
                            {detectionResult.gateType !== "unknown" ? `${detectionResult.gateType} DETECTED` : "NO GATEWAY FOUND"}
                          </span>
                          {detectionResult.confidence > 0 && (
                            <span className="ml-auto font-mono text-xs text-primary">{detectionResult.confidence}%</span>
                          )}
                        </div>
                        <div className="font-mono text-[10px] text-muted-foreground">
                          Crawled {detectionResult.crawledPaths?.length || 0} paths: {detectionResult.crawledPaths?.join(", ") || "none"}
                        </div>
                        {detectionResult.signals?.length > 0 && (
                          <div className="space-y-0.5 max-h-20 overflow-y-auto">
                            {detectionResult.signals.map((sig: string, i: number) => (
                              <div key={i} className="font-mono text-[10px] text-muted-foreground">
                                <span className="text-primary">+</span> {sig}
                              </div>
                            ))}
                          </div>
                        )}
                        {detectionResult.settings?.publicKey && (
                          <div className="border-t border-primary/10 pt-1">
                            <div className="font-mono text-[10px] text-primary break-all">
                              PK: {detectionResult.settings.publicKey}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    <div className="space-y-2">
                      <Label className="text-xs font-mono uppercase text-muted-foreground">Gate Type</Label>
                      <Select value={newGate.gateType} onValueChange={(v) => setNewGate(prev => ({ ...prev, gateType: v, subType: "" }))}>
                        <SelectTrigger className="rounded-none border-white/[0.08]"><SelectValue placeholder="Select or auto-detect" /></SelectTrigger>
                        <SelectContent>
                          {typesList.map((t: any) => (
                            <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {selectedTypeSubtypes.length > 0 && (
                      <div className="space-y-2">
                        <Label className="text-xs font-mono uppercase text-muted-foreground">Sub-Type</Label>
                        <Select value={newGate.subType} onValueChange={(v) => setNewGate(prev => ({ ...prev, subType: v }))}>
                          <SelectTrigger className="rounded-none border-white/[0.08]"><SelectValue placeholder="Auto-select" /></SelectTrigger>
                          <SelectContent>
                            {selectedTypeSubtypes.map((st: string) => {
                              const meta = FLOW_META[newGate.gateType]?.[st];
                              return (
                                <SelectItem key={st} value={st}>{meta?.label || st.replace(/_/g, " ").toUpperCase()}</SelectItem>
                              );
                            })}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    <div className="space-y-2">
                      <Label className="text-xs font-mono uppercase text-muted-foreground">Config Name</Label>
                      <Input
                        value={newGate.name}
                        onChange={(e) => setNewGate(prev => ({ ...prev, name: e.target.value }))}
                        placeholder="Auto-generated from detection"
                        className="rounded-none border-white/[0.08] font-mono"
                        data-testid="input-gate-name"
                      />
                    </div>
                    <Button
                      onClick={() => {
                        const dup = checkDuplicateUrl(newGate.url);
                        if (dup) {
                          toast({ title: "DUPLICATE URL", description: `Gate "${dup.name}" already uses this URL.`, variant: "destructive" });
                          return;
                        }
                        createGateMutation.mutate(newGate);
                      }}
                      disabled={!newGate.name || !newGate.gateType || !newGate.url || createGateMutation.isPending}
                      className="w-full rounded-none bg-primary text-black hover:bg-primary/90 font-display tracking-widest"
                      data-testid="button-create-gate"
                    >
                      {createGateMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                      CREATE GATE
                    </Button>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-white/[0.04]">
              {gateList.length === 0 ? (
                <div className="p-10 text-center space-y-2">
                  <Shield className="w-8 h-8 text-muted-foreground/20 mx-auto" />
                  <p className="text-muted-foreground font-mono text-sm">No gates configured</p>
                  <p className="text-muted-foreground/50 font-mono text-xs">Use MASS SETUP to scan sites, or NEW CONFIG for manual entry</p>
                </div>
              ) : (
                gateList.map((gate: any) => {
                  const gs = gate.settings || {};
                  const hasKey = !!(gs.publicKey || gs.btClientToken);
                  const isExpanded = expandedGate === gate.id;
                  return (
                    <div key={gate.id} className={`transition-colors ${gate.active ? "hover:bg-white/[0.03]" : "opacity-50 hover:bg-white/[0.03]"}`} data-testid={`card-gate-${gate.id}`}>
                      <div className="px-3 sm:px-4 py-2.5 flex items-center gap-2 sm:gap-3">
                        {/* Status dot */}
                        <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${gate.active ? "bg-primary" : "bg-muted-foreground/20"}`} />

                        {/* Main info */}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-semibold text-foreground text-xs sm:text-sm truncate">{gate.name}</span>
                            <span className={`px-1.5 py-px text-[9px] sm:text-[10px] font-mono border leading-relaxed ${getGateColor(gate.gateType)}`}>{gate.gateType.toUpperCase()}</span>
                            <span className="px-1.5 py-px text-[9px] sm:text-[10px] font-mono bg-accent/10 text-accent border border-accent/30 leading-relaxed">{(gate.subType || "std").replace(/_/g, " ").toUpperCase()}</span>
                            {gate.country && (
                              <span className="px-1.5 py-px text-[9px] sm:text-[10px] font-mono bg-muted/20 text-muted-foreground border border-muted/40 hidden sm:inline leading-relaxed" title="Routing country">{gate.country.toUpperCase()}</span>
                            )}
                            {hasKey && (
                              <span className="px-1.5 py-px text-[9px] sm:text-[10px] font-mono bg-primary/10 text-primary border border-white/[0.08] flex items-center gap-0.5 leading-relaxed">
                                <Key className="w-2.5 h-2.5" /> KEY
                              </span>
                            )}
                            {gs.captchaType && (
                              <span className="px-1.5 py-px text-[9px] sm:text-[10px] font-mono bg-yellow-500/10 text-yellow-400 border border-yellow-500/20 flex items-center gap-0.5 hidden sm:flex leading-relaxed">
                                <AlertCircle className="w-2.5 h-2.5" /> {gs.captchaType.toUpperCase()}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            <p className="text-[10px] sm:text-[11px] font-mono text-muted-foreground/50 truncate max-w-[200px] sm:max-w-[300px]">{gate.url}</p>
                            {gs.publicKey && (
                              <p className="text-[10px] font-mono text-primary/40 truncate max-w-[150px] sm:max-w-[200px] hidden sm:block">
                                {gs.publicKey.startsWith("pk_live") ? "pk_live_" : "pk_test_"}{gs.publicKey.slice(8, 14)}…
                              </p>
                            )}
                          </div>
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-px shrink-0">
                          {gs.publicKey && (
                            <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground/30 hover:text-primary rounded-none hidden sm:flex"
                              onClick={() => { navigator.clipboard.writeText(gs.publicKey); toast({ title: "Copied", description: "Public key copied." }); }}
                              title="Copy public key">
                              <Copy className="w-3 h-3" />
                            </Button>
                          )}
                          <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground/30 hover:text-accent rounded-none"
                            onClick={() => openEditGate(gate)} title="Edit gate" data-testid={`button-edit-gate-${gate.id}`}>
                            <Pencil className="w-3 h-3" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground/30 hover:text-primary rounded-none"
                            onClick={() => setExpandedGate(isExpanded ? null : gate.id)} title="View settings" data-testid={`button-expand-gate-${gate.id}`}>
                            <ChevronRight className={`w-3.5 h-3.5 transition-transform duration-200 ${isExpanded ? "rotate-90" : ""}`} />
                          </Button>
                          <Switch checked={gate.active} onCheckedChange={(checked) => toggleGateMutation.mutate({ id: gate.id, active: checked })} className="data-[state=checked]:bg-primary scale-75" />
                          <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground/20 hover:text-destructive rounded-none"
                            onClick={() => deleteGateMutation.mutate(gate.id)} title="Delete gate" data-testid={`button-delete-gate-${gate.id}`}>
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                      </div>

                      {/* Expanded settings */}
                      {isExpanded && (
                        <div className="px-4 sm:px-6 pb-3 bg-white/[0.02] border-t border-primary/5">
                          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-x-4 sm:gap-x-6 gap-y-1 pt-2">
                            {Object.entries(gs)
                              .filter(([k]) => !["autoDetected", "subtypes", "hybridGates"].includes(k))
                              .map(([key, value]) => (
                                <div key={key} className="flex items-start gap-1.5 text-[10px] sm:text-[10px] font-mono py-0.5">
                                  <span className="text-accent/70 shrink-0 min-w-[80px] sm:min-w-[90px]">{key}:</span>
                                  <span className="text-foreground/60 break-all">
                                    {typeof value === "boolean" ? (value ? "true" : "false") :
                                     Array.isArray(value) ? value.join(", ") :
                                     typeof value === "object" ? JSON.stringify(value).slice(0, 60) :
                                     String(value).length > 50 ? String(value).slice(0, 50) + "…" : String(value)}
                                  </span>
                                  {(key === "publicKey" || key === "btClientToken") && (
                                    <button onClick={() => { navigator.clipboard.writeText(String(value)); toast({ title: "Copied" }); }} className="text-muted-foreground/40 hover:text-primary shrink-0 ml-auto">
                                      <Copy className="w-2.5 h-2.5" />
                                    </button>
                                  )}
                                </div>
                              ))}
                            {Object.keys(gs).filter(k => !["autoDetected", "subtypes", "hybridGates"].includes(k)).length === 0 && (
                              <p className="text-muted-foreground/40 font-mono text-[10px] col-span-3 py-1">No settings stored — edit to configure manually</p>
                            )}
                          </div>
                          <button onClick={() => openEditGate(gate)} className="mt-2 text-[10px] font-mono text-accent/60 hover:text-accent flex items-center gap-1 transition-colors">
                            <Pencil className="w-2.5 h-2.5" /> Edit & reconfigure
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </CardContent>

          {/* ── Gate Edit Dialog ─────────────────────────────────── */}
          <Dialog open={editGateOpen} onOpenChange={(open) => { setEditGateOpen(open); if (!open) { setEditGate(null); setEditTab("config"); setEditTestResult(null); } }}>
            <DialogContent className="bg-background border-white/[0.08] max-w-2xl max-h-[90vh] overflow-hidden flex flex-col p-0">
              {/* Header */}
              <div className="shrink-0 border-b border-white/[0.06] px-5 py-3">
                <div className="flex items-center gap-3">
                  <div className="w-7 h-7 border border-accent/40 bg-accent/10 flex items-center justify-center shrink-0">
                    <Pencil className="w-3.5 h-3.5 text-accent" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="font-display tracking-widest text-sm font-bold truncate">{editGate?.name || "Edit Gate"}</h3>
                    <p className="text-[10px] font-mono text-muted-foreground">{editGate?.gateType?.toUpperCase()} · {editGate?.subType}</p>
                  </div>
                  <div className={`px-2 py-0.5 text-[10px] font-mono border ${editGate?.active !== false ? "border-emerald-500/30 text-emerald-400" : "border-red-500/30 text-red-400"}`}>
                    {editGate?.active !== false ? "ACTIVE" : "INACTIVE"}
                  </div>
                  <Button
                    onClick={handleEditTest}
                    disabled={editTesting || !editGate?.id}
                    size="sm"
                    variant="outline"
                    className="rounded-none border-white/10 text-muted-foreground font-mono text-[10px] h-7 px-2 hover:bg-white/[0.04] shrink-0"
                    title="Run a test card through this gate (unsaved changes included)"
                  >
                    {editTesting ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <FlaskConical className="w-3 h-3 mr-1" />}
                    TEST
                  </Button>
                </div>
                {/* Tab bar */}
                <div className="flex gap-0 mt-3 border-b border-primary/10 -mb-px overflow-x-auto custom-scrollbar">
                  {([
                    { id: "config",   label: "Config",   icon: Settings     },
                    { id: "keys",     label: "Keys & Nonces", icon: Key      },
                    { id: "amount",   label: "Amount",   icon: DollarSign   },
                    { id: "billing",  label: "Billing",  icon: User         },
                    { id: "advanced", label: "Advanced", icon: Cpu          },
                  ] as { id: typeof editTab; label: string; icon: any }[]).map(({ id, label, icon: Icon }) => (
                    <button
                      key={id}
                      onClick={() => setEditTab(id)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-mono border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                        editTab === id
                          ? "border-primary text-primary"
                          : "border-transparent text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <Icon className="w-3 h-3" />{label}
                    </button>
                  ))}
                </div>
              </div>

              {editGate && (
                <div className="flex-1 overflow-y-auto px-3 sm:px-5 py-3 sm:py-4 space-y-4">

                  {/* ════════ TAB: CONFIG ════════ */}
                  {editTab === "config" && (<>

                  {/* Adyen stub warning */}
                  {editGate?.gateType === "adyen" && (
                    <div className="border border-yellow-500/30 bg-yellow-500/5 p-3 text-[11px] font-mono">
                      <div className="flex items-center gap-2 text-yellow-400 font-bold mb-1">
                        <AlertTriangle className="w-3.5 h-3.5" /> ADYEN — DETECTION ONLY
                      </div>
                      <p className="text-yellow-400/70 leading-relaxed">Adyen gateway detection works but the checker flow is NOT implemented yet. Cards cannot be checked against Adyen gates. Use this gate type only for auto-detection reference.</p>
                    </div>
                  )}

                  {/* Tokenize flow deprecation warning */}
                  {editGate?.subType === "tokenize" && (
                    <div className="border border-yellow-500/20 bg-yellow-500/5 p-3 text-[11px] font-mono">
                      <div className="flex items-center gap-2 text-yellow-400 font-bold mb-1">
                        <AlertTriangle className="w-3.5 h-3.5" /> TOKENIZE — FORMAT CHECK ONLY
                      </div>
                      <p className="text-yellow-400/70 leading-relaxed">This flow creates a Stripe token but does NOT verify funds or charge the card. It only proves the card number format is valid. Cannot distinguish live from dead cards.</p>
                    </div>
                  )}

                  {/* ── Basic info ── */}
                  <div className="space-y-3">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/50 flex items-center gap-1.5 border-b border-primary/10 pb-1">
                      <Settings className="w-3 h-3" /> Basic Info
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-[10px] font-mono uppercase text-muted-foreground">Name</Label>
                        <Input value={editGate.name || ""} onChange={(e) => setEditGate((p: any) => ({ ...p, name: e.target.value }))}
                          className="rounded-none border-white/[0.08] font-mono text-sm h-8" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-[10px] font-mono uppercase text-muted-foreground">Gate Type</Label>
                        <Select value={editGate.gateType || ""} onValueChange={(v) => setEditGate((p: any) => ({ ...p, gateType: v, subType: "standard" }))}>
                          <SelectTrigger className="rounded-none border-white/[0.08] h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {typesList.map((t: any) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-[10px] font-mono uppercase text-muted-foreground">Flow / Sub-Type</Label>
                        <Select value={editGate.subType || "standard"} onValueChange={(v) => setEditGate((p: any) => ({ ...p, subType: v }))}>
                          <SelectTrigger className="rounded-none border-white/[0.08] h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {(typesList.find((t: any) => t.id === editGate.gateType)?.subtypes || ["standard"]).map((st: string) => {
                              const meta = FLOW_META[editGate.gateType]?.[st];
                              return (
                                <SelectItem key={st} value={st}>
                                  {meta?.label || st.replace(/_/g, " ").toUpperCase()}
                                </SelectItem>
                              );
                            })}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-[10px] font-mono uppercase text-muted-foreground">Active</Label>
                        <div className="flex items-center gap-2 h-8">
                          <Switch checked={editGate.active !== false} onCheckedChange={(v) => setEditGate((p: any) => ({ ...p, active: v }))} className="data-[state=checked]:bg-primary" />
                          <span className="text-xs font-mono text-muted-foreground">{editGate.active !== false ? "ON" : "OFF"}</span>
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-[10px] font-mono uppercase text-muted-foreground">Country (routing)</Label>
                        <Input
                          value={(editGate.country || "") as string}
                          onChange={(e) => setEditGate((p: any) => ({ ...p, country: e.target.value.toUpperCase().slice(0, 2) }))}
                          placeholder="US (blank = any)"
                          maxLength={2}
                          className="rounded-none border-primary/20 font-mono text-[10px] h-8 bg-white/[0.02] uppercase"
                        />
                        <p className="text-[10px] text-muted-foreground/50 font-mono">ISO-2 the merchant serves. Auto-route sends same-country cards here. Blank = any-country.</p>
                      </div>
                    </div>

                    {/* Flow guide — updates when gateType or subType changes */}
                    {editGate.gateType && (() => {
                      const flowMeta = FLOW_META[editGate.gateType]?.[editGate.subType || "standard"];
                      const gs = editGate.settings || {};
                      if (!flowMeta) return null;
                      // siteUrl is stored as editGate.url (not settings.siteUrl), so check both
                      const hasField = (f: string) => !!gs[f] || !!editGate[f] || (f === "siteUrl" && !!editGate.url);
                      const missing  = flowMeta.needs.filter(f => !hasField(f));
                      const present  = flowMeta.needs.filter(f =>  hasField(f));
                      const optional = (flowMeta.optional || []);
                      return (
                        <div className="border border-accent/20 bg-accent/5 p-2.5 space-y-1.5">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <span className="text-[10px] font-mono font-bold text-accent">{flowMeta.label}</span>
                              <p className="text-[10px] font-mono text-muted-foreground/70 mt-0.5 leading-relaxed">{flowMeta.desc}</p>
                            </div>
                            <div className={`shrink-0 px-1.5 py-0.5 text-[9px] font-mono border ${missing.length === 0 ? "border-emerald-500/40 text-emerald-400" : "border-yellow-500/40 text-yellow-400"}`}>
                              {missing.length === 0 ? "READY" : `${missing.length} missing`}
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                            {present.map(f => (
                              <span key={f} className="text-[10px] font-mono text-emerald-400">✓ {f}</span>
                            ))}
                            {missing.map(f => (
                              <span key={f} className="text-[10px] font-mono text-yellow-400">✗ {f} required</span>
                            ))}
                            {optional.map(f => (
                              <span key={f} className={`text-[10px] font-mono ${gs[f] ? "text-emerald-400/60" : "text-muted-foreground/40"}`}>
                                {gs[f] ? `✓ ${f}` : `· ${f} optional`}
                              </span>
                            ))}
                          </div>
                        </div>
                      );
                    })()}

                    <div className="space-y-1.5">
                      <Label className="text-[10px] font-mono uppercase text-muted-foreground">Target URL</Label>
                      <div className="flex gap-2">
                        <Input value={editGate.url || ""} onChange={(e) => setEditGate((p: any) => ({ ...p, url: e.target.value }))}
                          placeholder="https://example.com" className="rounded-none border-white/[0.08] font-mono text-xs flex-1 h-8" />
                        <Button onClick={handleEditRedetect} disabled={editDetecting || !editGate.url} size="sm"
                          className="rounded-none bg-accent/10 text-accent border border-accent/40 hover:bg-accent hover:text-black font-mono text-xs h-8 px-3 shrink-0">
                          {editDetecting ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <RefreshCw className="w-3 h-3 mr-1" />}
                          RE-DETECT
                        </Button>
                        <Button onClick={handleScrapeHints} disabled={hintLoading || !editGate.url} size="sm"
                          variant="outline"
                          className="rounded-none border-cyan-500/40 text-cyan-400 hover:bg-cyan-500/10 font-mono text-xs h-8 px-3 shrink-0"
                          title="Fetch the page and show what was extracted for each known field">
                          {hintLoading ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Search className="w-3 h-3 mr-1" />}
                          HINTS
                        </Button>
                      </div>
                    </div>
                    {scrapedHints && Object.keys(scrapedHints).length > 0 && (
                      <div className="border border-cyan-500/20 bg-cyan-500/5 p-2 space-y-1">
                        <div className="text-[10px] font-mono text-cyan-400 mb-1">EXTRACTED — click APPLY to copy into settings</div>
                        {Object.entries(scrapedHints).map(([k, v]) => (
                          <div key={k} className="flex items-center gap-2">
                            <span className="text-[10px] font-mono text-cyan-300/80 min-w-[140px]">{k}</span>
                            <span className="text-[10px] font-mono text-foreground/70 flex-1 truncate" title={v}>{v}</span>
                            <Button onClick={() => applyHint(k, v)} size="sm" variant="ghost"
                              className="h-5 px-2 text-[10px] font-mono text-cyan-400 hover:bg-cyan-500/20">APPLY</Button>
                          </div>
                        ))}
                      </div>
                    )}
                    {/* Gate profiles — saved bundles applied on top of current settings */}
                    {profiles.length > 0 && (
                      <div className="border border-white/[0.06] bg-white/[0.02] p-2 space-y-1">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[10px] font-mono text-primary">PROFILES</span>
                          <Button onClick={saveProfile} size="sm" variant="ghost" className="h-5 px-2 text-[10px] font-mono">+ SAVE CURRENT</Button>
                        </div>
                        {profiles.map(p => (
                          <div key={p.name} className="flex items-center gap-2">
                            <span className="text-[10px] font-mono text-foreground/70 flex-1 truncate">{p.name}</span>
                            <span className="text-[10px] font-mono text-muted-foreground/50">{p.gateType}</span>
                            <Button onClick={() => applyProfile(p)} size="sm" variant="ghost" className="h-5 px-2 text-[10px] font-mono text-emerald-400 hover:bg-emerald-500/20">APPLY</Button>
                            <Button onClick={() => deleteProfile(p.name)} size="sm" variant="ghost" className="h-5 px-1 text-[10px] font-mono text-red-400 hover:bg-red-500/20">×</Button>
                          </div>
                        ))}
                      </div>
                    )}
                    {profiles.length === 0 && (
                      <Button onClick={saveProfile} size="sm" variant="outline"
                        className="rounded-none border-primary/20 text-primary/70 hover:bg-primary/10 font-mono text-[10px] h-7 w-full"
                        title="Save the current settings as a reusable profile">
                        <Save className="w-3 h-3 mr-1" /> SAVE AS PROFILE
                      </Button>
                    )}
                  </div>

                  {/* ── Required Fields (dynamic per flow) ── */}
                  {editGate.gateType && (() => {
                    const flowMeta = FLOW_META[editGate.gateType]?.[editGate.subType || "standard"];
                    if (!flowMeta) return null;
                    const allFields = [
                      { key: "publicKey", label: "Stripe Public Key", placeholder: "pk_live_ or pk_test_...", gateTypes: ["stripe"] },
                      { key: "secretKey", label: "Stripe Secret Key", placeholder: "sk_live_... (server-side)", gateTypes: ["stripe"] },
                      { key: "btClientToken", label: "Braintree Client Token", placeholder: "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiIs...", gateTypes: ["braintree"] },
                      { key: "btMerchantId", label: "Braintree Merchant ID", placeholder: "wdk3wg9ymdvp6gqq", gateTypes: ["braintree"] },
                      { key: "wcNonce", label: "WC Checkout Nonce", placeholder: "woocommerce-process-checkout-nonce value", gateTypes: ["stripe", "braintree", "paypal"] },
                      { key: "stripeAccount", label: "Stripe Connected Account", placeholder: "acct_XXXXXXXXXXXX", gateTypes: ["stripe"] },
                      { key: "siteUrl", label: "Site URL", placeholder: "https://example.com", gateTypes: ["stripe", "shopify", "braintree", "paypal", "payeezy", "adyen"], isGateUrl: true },
                      { key: "clientKey", label: "Adyen Client Key", placeholder: "AQEyhmfxK4PJahc0w0...", gateTypes: ["adyen"] },
                      { key: "merchantAccount", label: "Adyen Merchant Account", placeholder: "YourCompanyECOM", gateTypes: ["adyen"] },
                      { key: "checkoutUrl", label: "Adyen Checkout URL", placeholder: "https://checkout-api.adyen.com/v71/payments", gateTypes: ["adyen"] },
                      { key: "clientId", label: "PayPal Client ID", placeholder: "AeA... (auto-scraped if empty)", gateTypes: ["paypal"] },
                      { key: "addPmPath", label: "Add PM Path", placeholder: "/my-account/add-payment-method/", gateTypes: ["payeezy"] },
                    ];
                    const required = allFields.filter(f => flowMeta.needs.includes(f.key) && f.gateTypes.includes(editGate.gateType));
                    const optional = allFields.filter(f => (flowMeta.optional || []).includes(f.key) && f.gateTypes.includes(editGate.gateType));
                    if (required.length === 0 && optional.length === 0) return null;
                    return (
                      <div className="space-y-3">
                        <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/50 flex items-center gap-1.5 border-b border-primary/10 pb-1">
                          <Key className="w-3 h-3" /> Required Fields
                          <span className="text-muted-foreground/30 ml-1 normal-case font-normal">for {flowMeta.label}</span>
                        </div>
                        <div className="space-y-2">
                          {required.map(({ key, label, placeholder, isGateUrl }) => (
                            <div key={key} className="grid grid-cols-[160px_1fr] items-center gap-2">
                              <Label className="text-[10px] font-mono text-muted-foreground/80 text-right">{label} <span className="text-red-400">*</span></Label>
                              <div className="flex gap-1.5">
                                {isGateUrl ? (
                                  <Input value={editGate.url || ""} onChange={(e) => setEditGate((p: any) => ({ ...p, url: e.target.value }))}
                                    placeholder={placeholder} className="rounded-none border-white/[0.08] font-mono text-[10px] h-7 bg-white/[0.02] flex-1" />
                                ) : (
                                  <Input value={(editGate.settings?.[key] || "") as string}
                                    onChange={(e) => setEditSetting(key, e.target.value || undefined)}
                                    placeholder={placeholder}
                                    className="rounded-none border-white/[0.08] font-mono text-[10px] h-7 bg-white/[0.02] flex-1" />
                                )}
                                {editGate.settings?.[key] && !isGateUrl && (
                                  <button onClick={() => { navigator.clipboard.writeText(editGate.settings[key]); toast({ title: "Copied" }); }}
                                    className="text-muted-foreground/40 hover:text-primary px-1.5 border border-white/[0.06] shrink-0">
                                    <Copy className="w-2.5 h-2.5" />
                                  </button>
                                )}
                              </div>
                            </div>
                          ))}
                          {optional.map(({ key, label, placeholder }) => (
                            <div key={key} className="grid grid-cols-[160px_1fr] items-center gap-2">
                              <Label className="text-[10px] font-mono text-muted-foreground/60 text-right">{label} <span className="text-muted-foreground/30">optional</span></Label>
                              <div className="flex gap-1.5">
                                <Input value={(editGate.settings?.[key] || "") as string}
                                  onChange={(e) => setEditSetting(key, e.target.value || undefined)}
                                  placeholder={placeholder}
                                  className="rounded-none border-white/[0.08] font-mono text-[10px] h-7 bg-white/[0.02] flex-1" />
                                {editGate.settings?.[key] && (
                                  <button onClick={() => { navigator.clipboard.writeText(editGate.settings[key]); toast({ title: "Copied" }); }}
                                    className="text-muted-foreground/40 hover:text-primary px-1.5 border border-white/[0.06] shrink-0">
                                    <Copy className="w-2.5 h-2.5" />
                                  </button>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })()}

                  {/* ── Braintree Settings (visible when gateType is braintree) ── */}
                  {editGate.gateType === "braintree" && (
                  <div className="space-y-3">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/50 flex items-center gap-1.5 border-b border-[hsl(280_100%_60%)]/20 pb-1">
                      <span className="text-[hsl(280_100%_60%)]">◆</span> Braintree Settings
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-[10px] font-mono uppercase text-muted-foreground">BT Flow</Label>
                        <Select
                          value={editGate.settings?.btFlow || "_auto_"}
                          onValueChange={(v) => setEditSetting("btFlow", v === "_auto_" ? undefined : v)}
                        >
                          <SelectTrigger className="rounded-none border-primary/20 h-7 text-xs bg-white/[0.02]"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="_auto_">Auto (addpm → checkout)</SelectItem>
                            <SelectItem value="wc_braintree_addpm">WC Add-Payment-Method (vault)</SelectItem>
                            <SelectItem value="wc_braintree">WC Standard Checkout</SelectItem>
                            <SelectItem value="bigcommerce_stencil">BigCommerce Stencil</SelectItem>
                          </SelectContent>
                        </Select>
                        <p className="text-[10px] text-muted-foreground/50 font-mono">Auto tries addpm first, then falls back to WC checkout</p>
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-[10px] font-mono uppercase text-muted-foreground">BT Merchant ID</Label>
                        <Input
                          value={(editGate.settings?.btMerchantId || "") as string}
                          onChange={(e) => setEditSetting("btMerchantId", e.target.value || undefined)}
                          placeholder="wdk3wg9ymdvp6gqq"
                          className="rounded-none border-primary/20 font-mono text-[10px] h-7 bg-white/[0.02]"
                        />
                        <p className="text-[10px] text-muted-foreground/50 font-mono">Fallback if not in token</p>
                      </div>
                    </div>
                    <div className="grid grid-cols-[160px_1fr] items-center gap-2">
                      <Label className="text-[10px] font-mono text-muted-foreground/80 text-right">Add-PM Path</Label>
                      <Input
                        value={(editGate.settings?.addPmPath || "") as string}
                        onChange={(e) => setEditSetting("addPmPath", e.target.value || undefined)}
                        placeholder="/my-account/add-payment-method/"
                        className="rounded-none border-primary/20 font-mono text-[10px] h-7 bg-white/[0.02]"
                      />
                    </div>
                    <div className="border border-[hsl(280_100%_60%)]/10 bg-[hsl(280_100%_60%)]/5 p-2.5 text-[10px] font-mono text-muted-foreground space-y-0.5">
                      <div className="text-[hsl(280_100%_60%)] font-bold mb-1">Flow guide</div>
                      <div><span className="text-accent">WC Add-PM</span> — saves card to WC vault; good for sites with My Account</div>
                      <div><span className="text-accent">WC Checkout</span> — real purchase checkout; requires a product in cart</div>
                      <div><span className="text-accent">Auto</span> — tries addpm first, falls back to checkout, then token-only</div>
                    </div>
                  </div>
                  )}

                  {/* ── Shopify Settings ── */}
                  {editGate.gateType === "shopify" && (
                  <div className="space-y-3">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/50 flex items-center gap-1.5 border-b border-emerald-400/20 pb-1">
                      <span className="text-emerald-400">◆</span> Shopify Settings
                    </div>
                    <div className="grid grid-cols-[160px_1fr] items-center gap-2">
                      <Label className="text-[10px] font-mono text-muted-foreground/80 text-right">Checkout Scope</Label>
                      <Input
                        value={(editGate.settings?.checkoutScope || "") as string}
                        onChange={(e) => setEditSetting("checkoutScope", e.target.value || undefined)}
                        placeholder="store.myshopify.com  (auto-derived if blank)"
                        className="rounded-none border-primary/20 font-mono text-[10px] h-7 bg-white/[0.02]"
                      />
                    </div>
                    <div className="grid grid-cols-[160px_1fr] items-center gap-2">
                      <Label className="text-[10px] font-mono text-muted-foreground/80 text-right">Product Handle</Label>
                      <Input
                        value={(editGate.settings?.productHandle || "") as string}
                        onChange={(e) => setEditSetting("productHandle", e.target.value || undefined)}
                        placeholder="blue-shirt  (optional — for cart-based flow)"
                        className="rounded-none border-primary/20 font-mono text-[10px] h-7 bg-white/[0.02]"
                      />
                    </div>
                    <div className="border border-emerald-400/10 bg-emerald-400/5 p-2.5 text-[10px] font-mono text-muted-foreground space-y-0.5">
                      <div className="text-emerald-400 font-bold mb-1">Flow</div>
                      <div><span className="text-accent">PCI</span> — POST card to checkout.pci.shopifyinc.com → SubmitForCompletion GQL → PollForReceipt</div>
                      <div><span className="text-accent">Scope</span> auto-derived from site URL as <span className="text-primary/70">store.myshopify.com</span></div>
                    </div>
                  </div>
                  )}

                  {/* ── Payeezy Settings (visible when gateType is payeezy) ── */}
                  {editGate.gateType === "payeezy" && (
                  <div className="space-y-3">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/50 flex items-center gap-1.5 border-b border-cyan-400/20 pb-1">
                      <span className="text-cyan-400">◆</span> Payeezy Settings
                    </div>
                    <div className="grid grid-cols-[160px_1fr] items-center gap-2">
                      <Label className="text-[10px] font-mono text-muted-foreground/80 text-right">Add-PM Path</Label>
                      <Input
                        value={(editGate.settings?.addPmPath || "") as string}
                        onChange={(e) => setEditSetting("addPmPath", e.target.value || undefined)}
                        placeholder="/my-account/add-payment-method/"
                        className="rounded-none border-primary/20 font-mono text-[10px] h-7 bg-white/[0.02]"
                      />
                    </div>
                    <div className="border border-cyan-400/10 bg-cyan-400/5 p-2.5 text-[10px] font-mono text-muted-foreground">
                      Card fields POST directly to the WC add-payment-method endpoint as <span className="text-accent">first_data_payeezy_gateway_credit_card</span> — no external tokenization API.
                    </div>
                  </div>
                  )}

                  {/* ── Form / Donation ── */}
                  <div className="space-y-3">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/50 flex items-center gap-1.5 border-b border-primary/10 pb-1">
                      <Globe className="w-3 h-3" /> Form & Platform
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-[10px] font-mono uppercase text-muted-foreground">Platform</Label>
                        <Select
                          value={editGate.settings?.platform || "_none_"}
                          onValueChange={(v) => setEditSetting("platform", v === "_none_" ? undefined : v)}
                        >
                          <SelectTrigger className="rounded-none border-primary/20 h-7 text-xs bg-white/[0.02]"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="_none_">Auto / Unknown</SelectItem>
                            <SelectItem value="woocommerce">WooCommerce</SelectItem>
                            <SelectItem value="shopify">Shopify</SelectItem>
                            <SelectItem value="givewp">GiveWP</SelectItem>
                            <SelectItem value="gravityforms">GravityForms</SelectItem>
                            <SelectItem value="bigcommerce">BigCommerce</SelectItem>
                            <SelectItem value="payeezy">Payeezy</SelectItem>
                            <SelectItem value="whmcs">WHMCS</SelectItem>
                            <SelectItem value="custom">Custom</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-[10px] font-mono uppercase text-muted-foreground">Form Type</Label>
                        <Select
                          value={editGate.settings?.formType || "_none_"}
                          onValueChange={(v) => setEditSetting("formType", v === "_none_" ? undefined : v)}
                        >
                          <SelectTrigger className="rounded-none border-primary/20 h-7 text-xs bg-white/[0.02]"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="_none_">None / Standard</SelectItem>
                            <SelectItem value="charitable">Charitable</SelectItem>
                            <SelectItem value="givewp">GiveWP</SelectItem>
                            <SelectItem value="gravityforms">Gravity Forms</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div className="grid grid-cols-[160px_1fr] items-center gap-2">
                      <Label className="text-[10px] font-mono text-muted-foreground/80 text-right">Donate Path</Label>
                      <Input value={(editGate.settings?.donatePath || "") as string} onChange={(e) => setEditSetting("donatePath", e.target.value || undefined)}
                        placeholder="/donate or /give" className="rounded-none border-primary/20 font-mono text-[10px] h-7 bg-white/[0.02]" />
                    </div>
                    <div className="grid grid-cols-[160px_1fr] items-center gap-2">
                      <Label className="text-[10px] font-mono text-muted-foreground/80 text-right">GiveWP Form ID</Label>
                      <Input value={(editGate.settings?.giveFormId || "") as string} onChange={(e) => setEditSetting("giveFormId", e.target.value || undefined)}
                        placeholder="123" className="rounded-none border-primary/20 font-mono text-[10px] h-7 bg-white/[0.02]" />
                    </div>
                    <div className="grid grid-cols-[160px_1fr] items-center gap-2">
                      <Label className="text-[10px] font-mono text-muted-foreground/80 text-right">GiveWP Form Prefix</Label>
                      <Input value={(editGate.settings?.giveFormIdPrefix || "") as string} onChange={(e) => setEditSetting("giveFormIdPrefix", e.target.value || undefined)}
                        placeholder="6203-1 (form-id + suffix)" className="rounded-none border-primary/20 font-mono text-[10px] h-7 bg-white/[0.02]" />
                    </div>
                    <div className="grid grid-cols-[160px_1fr] items-center gap-2">
                      <Label className="text-[10px] font-mono text-muted-foreground/80 text-right">GF Form ID</Label>
                      <Input value={(editGate.settings?.gfFormId || "") as string} onChange={(e) => setEditSetting("gfFormId", e.target.value || undefined)}
                        placeholder="1" className="rounded-none border-primary/20 font-mono text-[10px] h-7 bg-white/[0.02]" />
                    </div>
                    <div className="grid grid-cols-[160px_1fr] items-center gap-2">
                      <Label className="text-[10px] font-mono text-muted-foreground/80 text-right">Charitable Form ID</Label>
                      <Input value={(editGate.settings?.charitableFormId || "") as string} onChange={(e) => setEditSetting("charitableFormId", e.target.value || undefined)}
                        placeholder="42" className="rounded-none border-primary/20 font-mono text-[10px] h-7 bg-white/[0.02]" />
                    </div>
                    <div className="grid grid-cols-[160px_1fr] items-center gap-2">
                      <Label className="text-[10px] font-mono text-muted-foreground/80 text-right">WP Full Stripe Form Name</Label>
                      <Input value={(editGate.settings?.wpFsFormName || "") as string} onChange={(e) => setEditSetting("wpFsFormName", e.target.value || undefined)}
                        placeholder="RiverNetworkChurchDonation" className="rounded-none border-primary/20 font-mono text-[10px] h-7 bg-white/[0.02]" />
                    </div>
                    <div className="grid grid-cols-[160px_1fr] items-center gap-2">
                      <Label className="text-[10px] font-mono text-muted-foreground/80 text-right">WPFS Custom Inputs</Label>
                      <Input type="number" min={0} value={(editGate.settings?.wpfsCustomInputCount ?? "") as any} onChange={(e) => setEditSetting("wpfsCustomInputCount", e.target.value ? parseInt(e.target.value, 10) : undefined)}
                        placeholder="1 (default — admin-defined wpfs-custom-input field count)" className="rounded-none border-primary/20 font-mono text-[10px] h-7 bg-white/[0.02]" />
                    </div>
                    <div className="grid grid-cols-[160px_1fr] items-center gap-2">
                      <Label className="text-[10px] font-mono text-muted-foreground/80 text-right">AJAX URL Override</Label>
                      <Input value={(editGate.settings?.ajaxUrl || "") as string} onChange={(e) => setEditSetting("ajaxUrl", e.target.value || undefined)}
                        placeholder="/wp-admin/admin-ajax.php (default; override when site returns 404)" className="rounded-none border-primary/20 font-mono text-[10px] h-7 bg-white/[0.02]" />
                    </div>
                    <div className="grid grid-cols-[160px_1fr] items-center gap-2">
                      <Label className="text-[10px] font-mono text-muted-foreground/80 text-right">GF PI Nonce</Label>
                      <Input value={(editGate.settings?.gfPaymentIntentNonce || "") as string} onChange={(e) => setEditSetting("gfPaymentIntentNonce", e.target.value || undefined)}
                        placeholder="nonce value" className="rounded-none border-primary/20 font-mono text-[10px] h-7 bg-white/[0.02]" />
                    </div>

                    {/* GiveWP — subscription mode + payment mode */}
                    {(["givewp","givewp_v3","charitable"].includes(editGate.subType || "") || editGate.settings?.formType === "givewp") && (<>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-[10px] font-mono uppercase text-muted-foreground">Donation Type</Label>
                        <Select
                          value={editGate.settings?.donationType || "single"}
                          onValueChange={(v) => setEditSetting("donationType", v === "single" ? undefined : v)}
                        >
                          <SelectTrigger className="rounded-none border-primary/20 h-7 text-xs bg-white/[0.02]"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="single">Single (one-off charge)</SelectItem>
                            <SelectItem value="subscription">Subscription (off_session SetupIntent)</SelectItem>
                          </SelectContent>
                        </Select>
                        <p className="text-[10px] font-mono text-muted-foreground/50">Subscription uses setup_future_usage=off_session — catches more issuer responses</p>
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-[10px] font-mono uppercase text-muted-foreground">Payment Mode</Label>
                        <Select
                          value={editGate.settings?.paymentMode || "_stripe_"}
                          onValueChange={(v) => setEditSetting("paymentMode", v === "_stripe_" ? undefined : v)}
                        >
                          <SelectTrigger className="rounded-none border-primary/20 h-7 text-xs bg-white/[0.02]"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="_stripe_">stripe (default)</SelectItem>
                            <SelectItem value="stripe_v3">stripe_v3</SelectItem>
                            <SelectItem value="paypal-commerce">paypal-commerce</SelectItem>
                            <SelectItem value="paypal">paypal</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    </>)}

                    {/* Admin-ajax gate — ajaxAction is the key field */}
                    {editGate.settings?.ajaxAction && (<>
                    <div className="grid grid-cols-[160px_1fr] items-center gap-2">
                      <Label className="text-[10px] font-mono text-muted-foreground/80 text-right">Ajax Action</Label>
                      <div className="flex gap-1.5">
                        <Input value={(editGate.settings?.ajaxAction || "") as string} onChange={(e) => setEditSetting("ajaxAction", e.target.value || undefined)}
                          placeholder="give_process_donation" className="rounded-none border-primary/20 font-mono text-[10px] h-7 bg-white/[0.02] flex-1" />
                        {editGate.settings?.ajaxAction && (
                          <button onClick={() => { navigator.clipboard.writeText(editGate.settings.ajaxAction); toast({ title: "Copied" }); }}
                            className="text-muted-foreground/40 hover:text-primary px-1.5 border border-primary/10 shrink-0">
                            <Copy className="w-2.5 h-2.5" />
                          </button>
                        )}
                      </div>
                    </div>
                    </>)}
                  </div>


                  </>)}

                  {/* ════════ TAB: KEYS & NONCES ════════ */}
                  {editTab === "keys" && (<>

                  {/* Auth Keys */}
                  <div className="space-y-3">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/50 flex items-center gap-1.5 border-b border-primary/10 pb-1">
                      <Key className="w-3 h-3" /> Authentication Keys
                    </div>
                    <div className="space-y-2">
                      {[
                        { key: "publicKey",     label: "Stripe Public Key",        placeholder: "pk_live_…  or  pk_test_…" },
                        { key: "secretKey",     label: "Stripe Secret Key",        placeholder: "sk_live_…  (server-side tokenization)" },
                        { key: "btClientToken", label: "Braintree Client Token",   placeholder: "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiIs…" },
                        { key: "btMerchantId",  label: "Braintree Merchant ID",    placeholder: "wdk3wg9ymdvp6gqq  (fallback if not in token)" },
                        { key: "stripeAccount", label: "Stripe Connected Account", placeholder: "acct_XXXXXXXXXXXX" },
                        { key: "clientKey",     label: "Adyen Client Key",         placeholder: "AQEyhmfxK4PJahc0w0…" },
                        { key: "merchantAccount", label: "Adyen Merchant Account",  placeholder: "YourCompanyECOM" },
                        { key: "checkoutUrl",   label: "Adyen Checkout URL",       placeholder: "https://checkout-api.adyen.com/v71/payments" },
                        { key: "clientId",      label: "PayPal Client ID",         placeholder: "AeA… (auto-scraped if empty)" },
                        { key: "addPmPath",     label: "Add PM Path (Payeezy)",    placeholder: "/my-account/add-payment-method/" },
                      ].map(({ key, label, placeholder }) => (
                        <div key={key} className="space-y-1">
                          <Label className="text-[10px] font-mono text-muted-foreground/80">{label}</Label>
                          <div className="flex gap-1.5">
                            <Input
                              value={(editGate.settings?.[key] || "") as string}
                              onChange={(e) => setEditSetting(key, e.target.value || undefined)}
                              placeholder={placeholder}
                              className="rounded-none border-primary/20 font-mono text-[10px] h-7 bg-white/[0.02] flex-1"
                            />
                            {editGate.settings?.[key] && (
                              <button onClick={() => { navigator.clipboard.writeText(editGate.settings[key]); toast({ title: "Copied" }); }}
                                className="text-muted-foreground/40 hover:text-primary px-1.5 border border-primary/10 shrink-0">
                                <Copy className="w-2.5 h-2.5" />
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Braintree-specific keys & flow (shown when gateType is braintree) */}
                  {editGate.gateType === "braintree" && (
                  <div className="space-y-3">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/50 flex items-center gap-1.5 border-b border-[hsl(280_100%_60%)]/20 pb-1">
                      <span className="text-[hsl(280_100%_60%)]">◆</span> Braintree Flow
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[10px] font-mono text-muted-foreground/80">BT Flow Override</Label>
                      <Select
                        value={editGate.settings?.btFlow || "_auto_"}
                        onValueChange={(v) => setEditSetting("btFlow", v === "_auto_" ? undefined : v)}
                      >
                        <SelectTrigger className="rounded-none border-primary/20 h-7 text-xs bg-white/[0.02]"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="_auto_">Auto (addpm → checkout → token-only)</SelectItem>
                          <SelectItem value="wc_braintree_addpm">WC Add-Payment-Method (vault)</SelectItem>
                          <SelectItem value="wc_braintree">WC Standard Checkout with BT</SelectItem>
                          <SelectItem value="bigcommerce_stencil">BigCommerce Stencil</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[10px] font-mono text-muted-foreground/80">Add-PM Path Override</Label>
                      <Input
                        value={(editGate.settings?.addPmPath || "") as string}
                        onChange={(e) => setEditSetting("addPmPath", e.target.value || undefined)}
                        placeholder="/my-account/add-payment-method/"
                        className="rounded-none border-primary/20 font-mono text-[10px] h-7 bg-white/[0.02]"
                      />
                    </div>
                  </div>
                  )}

                  {/* Payeezy-specific keys (shown when gateType is payeezy) */}
                  {editGate.gateType === "payeezy" && (
                  <div className="space-y-3">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/50 flex items-center gap-1.5 border-b border-cyan-400/20 pb-1">
                      <span className="text-cyan-400">◆</span> Payeezy Flow
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[10px] font-mono text-muted-foreground/80">Add-PM Path Override</Label>
                      <Input
                        value={(editGate.settings?.addPmPath || "") as string}
                        onChange={(e) => setEditSetting("addPmPath", e.target.value || undefined)}
                        placeholder="/my-account/add-payment-method/"
                        className="rounded-none border-primary/20 font-mono text-[10px] h-7 bg-white/[0.02]"
                      />
                    </div>
                  </div>
                  )}

                  {/* Nonces */}
                  <div className="space-y-3">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/50 flex items-center gap-1.5 border-b border-primary/10 pb-1">
                      <Hash className="w-3 h-3" /> Nonces
                      <span className="text-muted-foreground/30 ml-1 normal-case font-normal">(pre-seed to skip scraping)</span>
                    </div>
                    <div className="space-y-2">
                      {[
                        { key: "wcNonce",              label: "WC Checkout Nonce",         placeholder: "woocommerce-process-checkout-nonce value" },
                        { key: "wcStoreNonce",         label: "WC Store API Nonce",        placeholder: "returned in Nonce response header" },
                        { key: "ajaxNonce",            label: "GiveWP AJAX Nonce",         placeholder: "give_global_vars.ajax_vars.ajaxNonce" },
                        { key: "gfPaymentIntentNonce", label: "GravityForms PI Nonce",     placeholder: "gfstripe_payment_intent_nonce" },
                        { key: "wpRestNonce",          label: "WordPress REST Nonce",      placeholder: "wp_rest nonce (X-WP-Nonce header)" },
                      ].map(({ key, label, placeholder }) => (
                        <div key={key} className="space-y-1">
                          <Label className="text-[10px] font-mono text-muted-foreground/80">{label}</Label>
                          <div className="flex gap-1.5">
                            <Input
                              value={(editGate.settings?.[key] || "") as string}
                              onChange={(e) => setEditSetting(key, e.target.value || undefined)}
                              placeholder={placeholder}
                              className="rounded-none border-primary/20 font-mono text-[10px] h-7 bg-white/[0.02] flex-1"
                            />
                            {editGate.settings?.[key] && (
                              <button onClick={() => { navigator.clipboard.writeText(editGate.settings[key]); toast({ title: "Copied" }); }}
                                className="text-muted-foreground/40 hover:text-primary px-1.5 border border-primary/10 shrink-0">
                                <Copy className="w-2.5 h-2.5" />
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Nonce info */}
                  <div className="border border-primary/10 bg-white/[0.02] p-3 text-[10px] font-mono text-muted-foreground space-y-1">
                    <div className="text-primary font-bold mb-1">TIP: When to pre-seed nonces</div>
                    <div>• WC Checkout Nonce — paste from page source if site blocks scraping</div>
                    <div>• WC Store API Nonce — from cart endpoint Nonce header (WooCommerce blocks checkout)</div>
                    <div>• GiveWP AJAX Nonce — from give_global_vars.ajax_vars.ajaxNonce in page source</div>
                    <div>• GF PI Nonce — from give_stripe_vars or page source; auto-detected if blank</div>
                    <div className="text-yellow-400/70 pt-1">Pre-seeded nonces save one HTTP round-trip per check but expire (usually hourly).</div>
                  </div>

                  </>)}

                  {/* ════════ TAB: AMOUNT ════════ */}
                  {editTab === "amount" && (<>

                  <div className="space-y-3">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/50 flex items-center gap-1.5 border-b border-primary/10 pb-1">
                      <DollarSign className="w-3 h-3" /> Charge Amount &amp; Currency
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-[10px] font-mono text-muted-foreground/80 uppercase">Donate / Charge Amount</Label>
                        <Input
                          type="number"
                          step="0.01"
                          min="0.01"
                          value={(editGate.settings?.donateAmount || "") as string}
                          onChange={(e) => setEditSetting("donateAmount", e.target.value || undefined)}
                          placeholder="5.00"
                          className="rounded-none border-primary/20 font-mono text-sm h-8 bg-white/[0.02]"
                        />
                        <p className="text-[10px] text-muted-foreground font-mono">Used by GiveWP (/give-amount), Charitable (custom_donation_amount), GravityForms (amount in cents × 100). Leave blank for defaults.</p>
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-[10px] font-mono text-muted-foreground/80 uppercase">Currency</Label>
                        <select
                          value={editGate.settings?.currency || "USD"}
                          onChange={(e) => setEditSetting("currency", e.target.value === "USD" ? undefined : e.target.value)}
                          className="w-full h-8 rounded-none border border-primary/20 bg-white/[0.02] text-xs font-mono px-2 text-foreground"
                        >
                          {["USD","EUR","GBP","CAD","AUD","JPY","CHF","SEK","NOK","DKK","NZD","SGD","HKD","MXN","BRL","INR","ZAR","AED","SAR","PLN"].map(c => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    {/* Quick amount presets */}
                    <div className="pt-1">
                      <Label className="text-[10px] font-mono text-muted-foreground/50 uppercase mb-2 block">Quick Presets</Label>
                      <div className="flex flex-wrap gap-1.5">
                        {["1.00","2.00","5.00","10.00","15.00","20.00","25.00","50.00","100.00"].map(a => (
                          <button
                            key={a}
                            onClick={() => setEditSetting("donateAmount", a)}
                            className={`px-2.5 py-1 text-[10px] font-mono border transition-colors ${
                              (editGate.settings?.donateAmount || "5.00") === a
                                ? "border-primary text-primary bg-primary/10"
                                : "border-primary/20 text-muted-foreground hover:border-primary/50 hover:text-foreground"
                            }`}
                          >
                            ${a}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Amount info box */}
                    <div className="border border-primary/10 bg-white/[0.02] p-3 text-[10px] font-mono text-muted-foreground space-y-1 mt-2">
                      <div className="text-primary font-bold mb-1">How amounts map to each gate type</div>
                      <div><span className="text-yellow-400">GiveWP</span> — give-amount &amp; give-form-minimum (decimal, e.g. "5.00")</div>
                      <div><span className="text-yellow-400">Charitable</span> — custom_donation_amount (decimal, e.g. "1.00")</div>
                      <div><span className="text-yellow-400">GravityForms</span> — PI create amount (auto-converted to cents, e.g. "5.00" → 500)</div>
                      <div><span className="text-yellow-400">WooCommerce</span> — amount is read from the cart; this field has no effect</div>
                    </div>
                  </div>

                  </>)}

                  {/* ════════ TAB: BILLING ════════ */}
                  {editTab === "billing" && (<>

                  <div className="space-y-3">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/50 flex items-center gap-1.5 border-b border-primary/10 pb-1">
                      <User className="w-3 h-3" /> Billing Override
                      <span className="text-muted-foreground/30 ml-1 normal-case font-normal">(blank = random)</span>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      {[
                        { key: "billingFirstName", label: "First Name",  placeholder: "John" },
                        { key: "billingLastName",  label: "Last Name",   placeholder: "Smith" },
                        { key: "billingEmail",     label: "Email",       placeholder: "john@example.com" },
                        { key: "billingPhone",     label: "Phone",       placeholder: "+1 555-000-0000" },
                      ].map(({ key, label, placeholder }) => (
                        <div key={key} className="space-y-1">
                          <Label className="text-[10px] font-mono text-muted-foreground/80">{label}</Label>
                          <Input
                            value={(editGate.settings?.[key] || "") as string}
                            onChange={(e) => setEditSetting(key, e.target.value || undefined)}
                            placeholder={placeholder}
                            className="rounded-none border-primary/20 font-mono text-[10px] h-7 bg-white/[0.02]"
                          />
                        </div>
                      ))}
                    </div>

                    <div className="space-y-2">
                      <div className="space-y-1">
                        <Label className="text-[10px] font-mono text-muted-foreground/80">Address Line 1</Label>
                        <Input
                          value={(editGate.settings?.billingAddress || "") as string}
                          onChange={(e) => setEditSetting("billingAddress", e.target.value || undefined)}
                          placeholder="123 Main St"
                          className="rounded-none border-primary/20 font-mono text-[10px] h-7 bg-white/[0.02]"
                        />
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        {[
                          { key: "billingCity",    label: "City",    placeholder: "New York" },
                          { key: "billingState",   label: "State",   placeholder: "NY" },
                          { key: "billingZip",     label: "ZIP",     placeholder: "10001" },
                        ].map(({ key, label, placeholder }) => (
                          <div key={key} className="space-y-1">
                            <Label className="text-[10px] font-mono text-muted-foreground/80">{label}</Label>
                            <Input
                              value={(editGate.settings?.[key] || "") as string}
                              onChange={(e) => setEditSetting(key, e.target.value || undefined)}
                              placeholder={placeholder}
                              className="rounded-none border-primary/20 font-mono text-[10px] h-7 bg-white/[0.02]"
                            />
                          </div>
                        ))}
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <Label className="text-[10px] font-mono text-muted-foreground/80">Country</Label>
                          <Select
                            value={editGate.settings?.billingCountry || "_random_"}
                            onValueChange={(v) => setEditSetting("billingCountry", v === "_random_" ? undefined : v)}
                          >
                            <SelectTrigger className="rounded-none border-primary/20 h-7 text-[10px] bg-white/[0.02] font-mono">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="_random_">🎲 Random (any)</SelectItem>
                              {([
                                ["US","United States"],["GB","United Kingdom"],["CA","Canada"],
                                ["AU","Australia"],["DE","Germany"],["FR","France"],["ES","Spain"],
                                ["IT","Italy"],["NL","Netherlands"],["SE","Sweden"],["NO","Norway"],
                                ["DK","Denmark"],["NZ","New Zealand"],["SG","Singapore"],["AE","UAE"],
                                ["JP","Japan"],["IN","India"],["BR","Brazil"],["MX","Mexico"],["PL","Poland"],
                              ] as [string,string][]).map(([code, name]) => (
                                <SelectItem key={code} value={code}>{code} — {name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="flex items-end pb-0.5">
                          <button
                            onClick={() => {
                              const keys = ["billingFirstName","billingLastName","billingEmail","billingPhone","billingAddress","billingCity","billingState","billingZip","billingCountry"];
                              keys.forEach(k => setEditSetting(k, undefined));
                            }}
                            className="text-[10px] font-mono text-muted-foreground/50 hover:text-red-400 flex items-center gap-1 h-7 px-2 border border-primary/10 hover:border-red-500/30 transition-colors"
                          >
                            <X className="w-3 h-3" /> Clear all billing
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="border border-primary/10 bg-white/[0.02] p-3 text-[10px] font-mono text-muted-foreground">
                      <span className="text-yellow-400/70">Note:</span> Blank fields use random realistic billing data per check (USA pool). Setting a field locks it to that value for every card checked against this gate.
                    </div>
                  </div>

                  </>)}

                  {/* ════════ TAB: ADVANCED ════════ */}
                  {editTab === "advanced" && (<>

                  {/* Gate Health */}
                  {gateHealth && (
                    <div className="space-y-2">
                      <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/50 flex items-center gap-1.5 border-b border-primary/10 pb-1">
                        <Activity className="w-3 h-3" /> Gate Health
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-center">
                        <div className="border border-white/[0.06] bg-white/[0.02] p-2">
                          <div className="text-[10px] font-mono text-muted-foreground/50">Checks / 10min</div>
                          <div className="text-lg font-mono font-bold text-cyan-400">{gateHealth.checks10min}</div>
                        </div>
                        <div className="border border-white/[0.06] bg-white/[0.02] p-2">
                          <div className="text-[10px] font-mono text-muted-foreground/50">Consec. Blocks</div>
                          <div className={`text-lg font-mono font-bold ${gateHealth.blocks >= 3 ? "text-red-400" : gateHealth.blocks >= 1 ? "text-yellow-400" : "text-emerald-400"}`}>
                            {gateHealth.blocks}
                          </div>
                        </div>
                        <div className="border border-white/[0.06] bg-white/[0.02] p-2">
                          <div className="text-[10px] font-mono text-muted-foreground/50">Last Check</div>
                          <div className="text-[10px] font-mono text-foreground/80 pt-1">
                            {gateHealth.lastCheck ? `${Math.round((Date.now() - gateHealth.lastCheck) / 1000)}s ago` : "—"}
                          </div>
                        </div>
                      </div>
                      {gateHealth.blocks >= 3 && (
                        <p className="text-[10px] text-red-400/80 font-mono">⚠ Site is throttling — requests being delayed 0.5–1.5s. Pause this gate or rotate proxies.</p>
                      )}
                    </div>
                  )}

                  {/* Failure-pattern analysis */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between border-b border-primary/10 pb-1">
                      <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/50 flex items-center gap-1.5">
                        <AlertCircle className="w-3 h-3" /> Failure Pattern Analysis
                      </span>
                      <Button onClick={analyzeFailures} disabled={analyzingFailures} size="sm" variant="outline"
                        className="h-6 px-2 text-[10px] font-mono border-yellow-500/40 text-yellow-400 hover:bg-yellow-500/10">
                        {analyzingFailures ? <Loader2 className="w-3 h-3 animate-spin" /> : "ANALYZE"}
                      </Button>
                    </div>
                    {failureSuggestions && failureSuggestions.sampleSize > 0 && (
                      <div className="space-y-1">
                        <p className="text-[10px] font-mono text-muted-foreground/60">Reviewed {failureSuggestions.sampleSize} recent checks · {failureSuggestions.suggestions.length} suggestion(s)</p>
                        {failureSuggestions.suggestions.map((s, i) => (
                          <div key={i} className="border border-yellow-500/20 bg-yellow-500/5 p-2 space-y-1">
                            <div className="flex items-start gap-2">
                              <span className="text-[10px] font-mono text-yellow-400/80 flex-1">{s.reason}</span>
                              <Button onClick={() => applySuggestion(s.settings)} size="sm" variant="ghost"
                                className="h-5 px-2 text-[10px] font-mono text-emerald-400 hover:bg-emerald-500/20 shrink-0">APPLY</Button>
                            </div>
                            <div className="text-[10px] font-mono text-foreground/50">
                              {Object.entries(s.settings).map(([k, v]) => <span key={k} className="mr-2">{k}={String(v) || "(clear)"}</span>)}
                              <span className="ml-auto text-muted-foreground/40">conf {(s.confidence * 100).toFixed(0)}%</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* AI Suggest & Polish */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between border-b border-accent/10 pb-1">
                      <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/50 flex items-center gap-1.5">
                        <Sparkles className="w-3 h-3 text-accent" /> AI Suggest &amp; Polish
                      </span>
                      <Button onClick={aiPolish} disabled={polishing} size="sm" variant="outline"
                        className="h-6 px-2 text-[10px] font-mono border-accent/40 text-accent hover:bg-accent/10">
                        {polishing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />} POLISH
                      </Button>
                    </div>
                    {polishResult && (
                      <div className="space-y-2 border border-accent/20 bg-accent/5 p-2">
                        <div className="flex items-center justify-between flex-wrap gap-2 text-[10px] font-mono">
                          <span className="text-muted-foreground/60">detected: {polishResult.detection.gateType}/{polishResult.detection.subType}</span>
                          <span className="text-emerald-400">conf {(polishResult.suggestions[0]?.confidence * 100 || 0).toFixed(0)}%</span>
                          {polishResult.detection.publicKey && <span className="text-cyan-400">key ✓</span>}
                        </div>
                        {polishResult.analysis && (
                          <p className="text-[10px] font-mono text-foreground/80">{polishResult.analysis}</p>
                        )}
                        <div className="flex flex-wrap gap-1">
                          {Object.entries(polishResult.suggestions[0]?.settings || {}).slice(0, 10).map(([k, v]: any) => (
                            <span key={k} className="border border-accent/15 bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px]">
                              <span className="text-cyan-400">{k}</span>=<span className="text-foreground/80">{String(v) || "(clear)"}</span>
                            </span>
                          ))}
                          {Object.keys(polishResult.suggestions[0]?.settings || {}).length === 0 && (
                            <span className="text-[10px] font-mono text-muted-foreground/50">No field changes suggested — config looks optimal.</span>
                          )}
                        </div>
                        <div className="flex gap-2 pt-1">
                          <Button onClick={() => applySuggestion(polishResult.suggestions[0]?.settings || {})} size="sm" variant="ghost"
                            className="h-6 px-2 text-[10px] font-mono text-emerald-400 hover:bg-emerald-500/20">
                            <Check className="w-2.5 h-2.5 mr-1" /> APPLY SUGGESTION
                          </Button>
                          <Button onClick={() => applySuggestion(polishResult.polishedSettings)} size="sm"
                            className="h-6 px-2 text-[10px] font-mono bg-accent/20 text-accent border border-accent hover:bg-accent hover:text-black">
                            <Sparkles className="w-2.5 h-2.5 mr-1" /> POLISH &amp; APPLY
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* ── Admin-ajax fields (always editable for imported gates) ── */}
                  {(editGate.settings?.ajaxAction || editGate.settings?.paymentMode) && (
                  <div className="space-y-3">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/50 flex items-center gap-1.5 border-b border-yellow-400/20 pb-1">
                      <span className="text-yellow-400">◆</span> Admin-Ajax Gate
                    </div>
                    {[
                      { key: "ajaxAction",   label: "Ajax Action",    placeholder: "give_process_donation" },
                      { key: "paymentMode",  label: "Payment Mode",   placeholder: "stripe  /  stripe_v3  /  paypal-commerce" },
                    ].map(({ key, label, placeholder }) => (
                      <div key={key} className="grid grid-cols-[130px_1fr] items-center gap-2">
                        <Label className="text-[10px] font-mono text-muted-foreground/80 text-right">{label}</Label>
                        <div className="flex gap-1.5">
                          <Input value={(editGate.settings?.[key] || "") as string}
                            onChange={(e) => setEditSetting(key, e.target.value || undefined)}
                            placeholder={placeholder}
                            className="rounded-none border-primary/20 font-mono text-[10px] h-7 bg-white/[0.02] flex-1" />
                          {editGate.settings?.[key] && (
                            <button onClick={() => { navigator.clipboard.writeText(editGate.settings[key]); toast({ title: "Copied" }); }}
                              className="text-muted-foreground/40 hover:text-primary px-1.5 border border-primary/10 shrink-0">
                              <Copy className="w-2.5 h-2.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  )}

                  {/* ── WooCommerce path overrides ── */}
                  <div className="text-[11px] font-mono font-bold uppercase tracking-widest text-red-400/70 border-b border-red-400/10 pb-1 mt-2">
                    Critical — Fix if broken
                  </div>
                  {(editGate.gateType === "stripe" || editGate.settings?.platform === "woocommerce") && (
                  <div className="space-y-3">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/50 flex items-center gap-1.5 border-b border-primary/10 pb-1">
                      <Globe className="w-3 h-3" /> WooCommerce Path Overrides
                    </div>
                    {[
                      { key: "shopPath",     label: "Shop Path",      placeholder: "/shop  (auto-discovered if blank)" },
                      { key: "checkoutPath", label: "Checkout Path",  placeholder: "/checkout  (auto-discovered if blank)" },
                    ].map(({ key, label, placeholder }) => (
                      <div key={key} className="grid grid-cols-[130px_1fr] items-center gap-2">
                        <Label className="text-[10px] font-mono text-muted-foreground/80 text-right">{label}</Label>
                        <Input value={(editGate.settings?.[key] || "") as string}
                          onChange={(e) => setEditSetting(key, e.target.value || undefined)}
                          placeholder={placeholder}
                          className="rounded-none border-primary/20 font-mono text-[10px] h-7 bg-white/[0.02]" />
                      </div>
                    ))}
                    <div className="grid grid-cols-[130px_1fr] items-center gap-2">
                      <Label className="text-[10px] font-mono text-muted-foreground/80 text-right">Product ID</Label>
                      <Input
                        type="number"
                        value={(editGate.settings?.productId != null ? String(editGate.settings.productId) : "") as string}
                        onChange={(e) => setEditSetting("productId", e.target.value ? Number(e.target.value) : undefined)}
                        placeholder="1822  (force a specific WC product for add-to-cart)"
                        className="rounded-none border-primary/20 font-mono text-[10px] h-7 bg-white/[0.02]"
                      />
                    </div>
                    <div className="grid grid-cols-[130px_1fr] gap-2">
                      <Label className="text-[10px] font-mono text-muted-foreground/80 text-right pt-1.5">Payment Slug</Label>
                      <PaymentSlugFields settings={editGate.settings} onSettingChange={setEditSetting} />
                    </div>
                    <p className="text-[10px] text-muted-foreground/50 font-mono">Leave blank to let the checker auto-discover shop/checkout paths and pick any available product.</p>
                  </div>
                  )}

                  <div className="text-[11px] font-mono font-bold uppercase tracking-widest text-yellow-400/60 border-b border-yellow-400/10 pb-1 mt-2">
                    Performance
                  </div>
                  {/* ── Proxy & Timeout ── */}
                  <div className="space-y-3">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/50 flex items-center gap-1.5 border-b border-primary/10 pb-1">
                      <Globe className="w-3 h-3" /> Proxy &amp; Timing
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-[10px] font-mono uppercase text-muted-foreground">Proxy Country</Label>
                        <Select
                          value={editGate.settings?.proxyCountry || "_pool_"}
                          onValueChange={(v) => setEditSetting("proxyCountry", v === "_pool_" ? undefined : v)}
                        >
                          <SelectTrigger className="rounded-none border-primary/20 h-7 text-xs bg-white/[0.02]"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="_pool_">Any (global pool)</SelectItem>
                            {["US","GB","CA","AU","DE","FR","NL","SE","NZ","SG","JP","IN","BR","PL","ES","IT","AE","MX"].map(c => (
                              <SelectItem key={c} value={c}>{c}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <p className="text-[10px] text-muted-foreground/50 font-mono">Pin pool proxy exit to a specific country — match billing country to reduce fraud flags</p>
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-[10px] font-mono uppercase text-muted-foreground">Request Timeout (ms)</Label>
                        <Select
                          value={String(editGate.settings?.timeout || "_default_")}
                          onValueChange={(v) => setEditSetting("timeout", v === "_default_" ? undefined : Number(v))}
                        >
                          <SelectTrigger className="rounded-none border-primary/20 h-7 text-xs bg-white/[0.02]"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="_default_">Default (20s)</SelectItem>
                            <SelectItem value="10000">10s — fast sites</SelectItem>
                            <SelectItem value="20000">20s — standard</SelectItem>
                            <SelectItem value="30000">30s — slow / captcha</SelectItem>
                            <SelectItem value="45000">45s — heavy flows</SelectItem>
                            <SelectItem value="60000">60s — maximum</SelectItem>
                          </SelectContent>
                        </Select>
                        <p className="text-[10px] text-muted-foreground/50 font-mono">Per-request abort timeout — increase for sites with slow admin-ajax responses</p>
                      </div>
                    </div>
                  </div>

                  {/* Stripe Connect & manual nonces */}
                  <div className="space-y-3">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/50 flex items-center gap-1.5 border-b border-primary/10 pb-1">
                      <Key className="w-3 h-3" /> Stripe Connect &amp; Manual Nonces
                    </div>
                    <div className="grid grid-cols-[140px_1fr] items-center gap-2">
                      <Label className="text-[10px] font-mono text-muted-foreground/80 text-right">Stripe acct_</Label>
                      <Input value={(editGate.settings?.connectedAccount || "") as string} onChange={(e) => setEditSetting("connectedAccount", e.target.value || undefined)}
                        placeholder="acct_1ABCdefGHIjklMNO (auto-extracted if blank)" className="rounded-none border-primary/20 font-mono text-[10px] h-7 bg-white/[0.02]" />
                    </div>
                    <div className="border border-primary/10 bg-white/[0.02] p-2.5 text-[10px] font-mono text-muted-foreground space-y-0.5">
                      <div className="text-primary font-bold mb-1">When to set this</div>
                      <div><span className="text-yellow-400">acct_</span> — marketplaces (GiveWP/Charitable) where auto-extraction misses the connected account ID</div>
                      <div className="text-muted-foreground/60 mt-1">Nonces are configured in the Keys tab.</div>
                    </div>
                  </div>

                  {/* Captcha solver */}
                  <div className="space-y-3">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/50 flex items-center gap-1.5 border-b border-primary/10 pb-1">
                      <Shield className="w-3 h-3" /> Captcha Solver
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-[10px] font-mono uppercase text-muted-foreground">Provider</Label>
                        <Select value={editGate.settings?.captchaProvider || "_none_"} onValueChange={(v) => setEditSetting("captchaProvider", v === "_none_" ? undefined : v)}>
                          <SelectTrigger className="rounded-none border-primary/20 h-7 text-xs bg-white/[0.02]"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="_none_">None (disabled)</SelectItem>
                            <SelectItem value="2captcha">2captcha</SelectItem>
                            <SelectItem value="anticaptcha">Anti-Captcha</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-[10px] font-mono uppercase text-muted-foreground">API Key</Label>
                        <Input
                          type="password"
                          value={(editGate.settings?.captchaApiKey || "") as string}
                          onChange={(e) => setEditSetting("captchaApiKey", e.target.value || undefined)}
                          placeholder="solver service API key"
                          className="rounded-none border-primary/20 font-mono text-[10px] h-7 bg-white/[0.02]"
                        />
                      </div>
                    </div>
                    <p className="text-[10px] text-muted-foreground/50 font-mono">Auto-solves Cloudflare Turnstile / hCaptcha when challenge HTML is detected. ~15–45s solve time.</p>
                  </div>

                  {/* Test card + manual overrides */}
                  <div className="space-y-3">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/50 flex items-center gap-1.5 border-b border-primary/10 pb-1">
                      <FlaskConical className="w-3 h-3" /> Manual Overrides
                    </div>
                    {[
                      { key: "testCardOverride", label: "Test Card",        placeholder: "PAN|MM|YY|CVC (used by the Test button)" },
                      { key: "walletConfigId",   label: "Wallet Config ID", placeholder: "UUID — overrides page-scrape (WHMCS Stripe Auth)" },
                    ].map(({ key, label, placeholder }) => (
                      <div key={key} className="grid grid-cols-[140px_1fr] items-center gap-2">
                        <Label className="text-[10px] font-mono text-muted-foreground/80 text-right">{label}</Label>
                        <Input value={(editGate.settings?.[key] || "") as string} onChange={(e) => setEditSetting(key, e.target.value || undefined)}
                          placeholder={placeholder} className="rounded-none border-primary/20 font-mono text-[10px] h-7 bg-white/[0.02]" />
                      </div>
                    ))}
                    <div className="space-y-1.5">
                      <Label className="text-[10px] font-mono uppercase text-muted-foreground">Raw Cookie Header</Label>
                      <Textarea
                        value={(editGate.settings?.rawCookies || "") as string}
                        onChange={(e) => setEditSetting("rawCookies", e.target.value || undefined)}
                        placeholder="name1=value1; name2=value2; …"
                        rows={2}
                        className="rounded-none border-primary/20 font-mono text-[10px] bg-white/[0.02] resize-none"
                      />
                      <p className="text-[10px] text-muted-foreground/50 font-mono">Pre-auth sessions — pasted Cookie seeds every request to this gate (Payeezy-style logged-in flow)</p>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-[10px] font-mono uppercase text-muted-foreground">Sticky Proxy URL</Label>
                      <Input
                        value={(editGate.settings?.proxyOverride || "") as string}
                        onChange={(e) => setEditSetting("proxyOverride", e.target.value || undefined)}
                        placeholder="http://user:pass@host:port (overrides pool)"
                        className="rounded-none border-primary/20 font-mono text-[10px] h-7 bg-white/[0.02]"
                      />
                      <p className="text-[10px] text-muted-foreground/50 font-mono">Pin all requests to one proxy — useful for sites that hate IP rotation</p>
                    </div>
                  </div>

                  {/* BIN Blacklist */}
                  <div className="space-y-3">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/50 flex items-center gap-1.5 border-b border-primary/10 pb-1">
                      <Shield className="w-3 h-3" /> BIN Blacklist
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-[10px] font-mono uppercase text-muted-foreground">Blocked BIN Prefixes (comma-separated)</Label>
                      <Textarea
                        value={(editGate.settings?.binBlacklist || "") as string}
                        onChange={(e) => setEditSetting("binBlacklist", e.target.value || undefined)}
                        placeholder="400000, 411111, 555555, …"
                        rows={2}
                        className="rounded-none border-primary/20 font-mono text-[10px] bg-white/[0.02] resize-none"
                      />
                      <p className="text-[10px] text-muted-foreground/50 font-mono">Cards whose BIN starts with any of these prefixes are rejected before hitting the gateway (no charge, instant skip)</p>
                    </div>
                  </div>

                  {/* 3DS / VBV pre-check */}
                  <div className="space-y-3">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/50 flex items-center gap-1.5 border-b border-primary/10 pb-1">
                      <Lock className="w-3 h-3" /> 3DS Pre-check &amp; Routing
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <Label className="text-[10px] font-mono uppercase text-muted-foreground">Enable 3DS Pre-check</Label>
                        <p className="text-[10px] text-muted-foreground/50 font-mono">Estimate a card's 3DS disposition before hitting the gate. Uses the external endpoint below if set, otherwise a BIN-country heuristic.</p>
                      </div>
                      <Switch
                        checked={editGate.settings?.vbvPreCheck === true}
                        onCheckedChange={(v) => setEditSetting("vbvPreCheck", v ? true : undefined)}
                        className="data-[state=checked]:bg-primary"
                      />
                    </div>
                    {editGate.settings?.vbvPreCheck === true && (
                      <>
                        <div className="space-y-1.5">
                          <Label className="text-[10px] font-mono uppercase text-muted-foreground">External VBV Endpoint (optional)</Label>
                          <Input
                            value={(editGate.settings?.vbvEndpoint || "") as string}
                            onChange={(e) => setEditSetting("vbvEndpoint", e.target.value || undefined)}
                            placeholder="https://your-vbv-service/check (blank = BIN heuristic only)"
                            className="rounded-none border-primary/20 font-mono text-[10px] h-7 bg-white/[0.02]"
                          />
                          <p className="text-[10px] text-muted-foreground/50 font-mono">Bring-your-own service queried as GET ?data=&#123;cc&#125;&amp;mode=3ds. Falls back to env VBV_CHECK_ENDPOINT.</p>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <Label className="text-[10px] font-mono uppercase text-muted-foreground">Skip on Declined</Label>
                            <p className="text-[10px] text-muted-foreground/50 font-mono">If the external endpoint returns "declined", skip the gate (saves time, avoids burning the card). Endpoint only.</p>
                          </div>
                          <Switch
                            checked={editGate.settings?.vbvSkipDeclined !== false}
                            onCheckedChange={(v) => setEditSetting("vbvSkipDeclined", v ? undefined : false)}
                            className="data-[state=checked]:bg-primary"
                          />
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <Label className="text-[10px] font-mono uppercase text-muted-foreground">Skip likely-3DS BINs (non-3DS gate)</Label>
                            <p className="text-[10px] text-muted-foreground/50 font-mono">Mark this gate as unable to clear a 3DS challenge. Cards whose BIN country mandates SCA (EEA/UK/IN) are skipped instead of returning requires_action.</p>
                          </div>
                          <Switch
                            checked={editGate.settings?.vbvSkip3dsBin === true}
                            onCheckedChange={(v) => setEditSetting("vbvSkip3dsBin", v ? true : undefined)}
                            className="data-[state=checked]:bg-primary"
                          />
                        </div>
                      </>
                    )}
                  </div>

                  {/* Response classifier overrides */}
                  <div className="text-[11px] font-mono font-bold uppercase tracking-widest text-cyan-400/60 border-b border-cyan-400/10 pb-1 mt-2">
                    Overrides
                  </div>
                  <div className="space-y-3">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/50 flex items-center gap-1.5 border-b border-primary/10 pb-1">
                      <Sparkles className="w-3 h-3" /> Response Classifier Overrides
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-[10px] font-mono uppercase text-muted-foreground">Force Live (comma-separated)</Label>
                      <Textarea
                        value={Array.isArray(editGate.settings?.liveOverrides)
                          ? editGate.settings.liveOverrides.join(", ")
                          : (editGate.settings?.liveOverrides || "")}
                        onChange={(e) => setEditSetting("liveOverrides", e.target.value || undefined)}
                        placeholder="incorrect_zip, do_not_honor, …"
                        rows={2}
                        className="rounded-none border-primary/20 font-mono text-[10px] bg-white/[0.02] resize-none"
                      />
                      <p className="text-[10px] text-muted-foreground/50 font-mono">Any decline code / keyword in this list flips the result to APPROVED</p>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-[10px] font-mono uppercase text-muted-foreground">Force Dead (comma-separated)</Label>
                      <Textarea
                        value={Array.isArray(editGate.settings?.deadOverrides)
                          ? editGate.settings.deadOverrides.join(", ")
                          : (editGate.settings?.deadOverrides || "")}
                        onChange={(e) => setEditSetting("deadOverrides", e.target.value || undefined)}
                        placeholder="insufficient_funds, …"
                        rows={2}
                        className="rounded-none border-primary/20 font-mono text-[10px] bg-white/[0.02] resize-none"
                      />
                      <p className="text-[10px] text-muted-foreground/50 font-mono">Force DECLINED for keywords your bank emits on live cards</p>
                    </div>
                  </div>

                  {/* Save behavior */}
                  <div className="space-y-3">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/50 flex items-center gap-1.5 border-b border-primary/10 pb-1">
                      <Save className="w-3 h-3" /> Save Behavior
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <Label className="text-[10px] font-mono uppercase text-muted-foreground">Auto-validate on Save</Label>
                        <p className="text-[10px] text-muted-foreground/50 font-mono">Run the test card immediately after saving and show the result before closing</p>
                      </div>
                      <Switch
                        checked={editGate.settings?.autoValidate === true}
                        onCheckedChange={(v) => setEditSetting("autoValidate", v ? true : undefined)}
                        className="data-[state=checked]:bg-primary"
                      />
                    </div>
                  </div>

                  {/* Donation / GiveWP overrides */}
                  <div className="space-y-3">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/50 flex items-center gap-1.5 border-b border-primary/10 pb-1">
                      <Globe className="w-3 h-3" /> Donation Gate Overrides
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-[10px] font-mono uppercase text-muted-foreground">Donate Path</Label>
                        <Input
                          value={(editGate.settings?.donatePath || "") as string}
                          onChange={(e) => setEditSetting("donatePath", e.target.value || undefined)}
                          placeholder="/donate/ (auto)"
                          className="rounded-none border-primary/20 font-mono text-[10px] h-7 bg-white/[0.02]"
                        />
                        <p className="text-[10px] text-muted-foreground/50 font-mono">Override donation page path for GiveWP / Charitable / PayPal</p>
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-[10px] font-mono uppercase text-muted-foreground">Donate Amount ($)</Label>
                        <Input
                          value={(editGate.settings?.donateAmount || "") as string}
                          onChange={(e) => setEditSetting("donateAmount", e.target.value || undefined)}
                          placeholder="0.50"
                          className="rounded-none border-primary/20 font-mono text-[10px] h-7 bg-white/[0.02]"
                        />
                        <p className="text-[10px] text-muted-foreground/50 font-mono">Amount to donate — use $0.50 for minimum-charge sites</p>
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-[10px] font-mono uppercase text-muted-foreground">Donation Type</Label>
                      <Select
                        value={editGate.settings?.donationType || "_single_"}
                        onValueChange={(v) => setEditSetting("donationType", v === "_single_" ? undefined : v)}
                      >
                        <SelectTrigger className="rounded-none border-primary/20 h-7 text-xs bg-white/[0.02]"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="_single_">Single (one-off PaymentIntent)</SelectItem>
                          <SelectItem value="subscription">Subscription (SetupIntent + off_session)</SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-[10px] text-muted-foreground/50 font-mono">Subscription mode creates a SetupIntent with subscriptionPeriod=month — bypasses sites that block one-off charges</p>
                    </div>
                  </div>

                  {/* Request tuning */}
                  <div className="space-y-3">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/50 flex items-center gap-1.5 border-b border-primary/10 pb-1">
                      <Cpu className="w-3 h-3" /> Request Tuning
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-[10px] font-mono uppercase text-muted-foreground">Max Retries</Label>
                      <Input
                        type="number"
                        min={0}
                        max={5}
                        value={(editGate.settings?.maxRetries || "") as string}
                        onChange={(e) => setEditSetting("maxRetries", e.target.value ? Number(e.target.value) : undefined)}
                        placeholder="2"
                        className="rounded-none border-primary/20 font-mono text-[10px] h-7 bg-white/[0.02]"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-[10px] font-mono uppercase text-muted-foreground">Custom User-Agent Override</Label>
                      <Input
                        value={(editGate.settings?.userAgent || "") as string}
                        onChange={(e) => setEditSetting("userAgent", e.target.value || undefined)}
                        placeholder="Mozilla/5.0 (Windows NT 10.0; Win64; x64) …"
                        className="rounded-none border-primary/20 font-mono text-[10px] h-7 bg-white/[0.02]"
                      />
                      <p className="text-[10px] text-muted-foreground font-mono">Leave blank to use the rotating UA pool (recommended)</p>
                    </div>
                  </div>

                  </>)}

                </div>
              )}

              {/* Test result banner */}
              {editTestResult && (
                <div className={`shrink-0 px-6 py-2 border-t font-mono text-[10px] flex items-center gap-2 ${
                  editTestResult.status === "approved"
                    ? "border-emerald-500/20 bg-emerald-500/5 text-emerald-400"
                    : editTestResult.status === "error"
                    ? "border-yellow-500/20 bg-yellow-500/5 text-yellow-400"
                    : "border-red-500/20 bg-red-500/5 text-red-400"
                }`}>
                  {editTestResult.status === "approved"
                    ? <CheckCircle className="w-3.5 h-3.5 shrink-0" />
                    : editTestResult.status === "error"
                    ? <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    : <XCircle className="w-3.5 h-3.5 shrink-0" />}
                  <span className="font-bold uppercase">{editTestResult.status}</span>
                  <span className="text-foreground/60 truncate">{editTestResult.response}</span>
                  <span className="ml-auto shrink-0 opacity-50">{editTestResult.latency}ms</span>
                </div>
              )}

              <div className="shrink-0 border-t border-primary/20 bg-white/[0.02] px-6 py-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono text-muted-foreground/30">ID: {editGate?.id?.slice(0, 14)}…</span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleEditTest}
                    disabled={editTesting || !editGate?.id}
                    className="rounded-none border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10 font-mono text-[10px] h-7 px-2"
                    title="Run one test card through this gate to verify it responds"
                  >
                    {editTesting
                      ? <Loader2 className="w-3 h-3 animate-spin mr-1" />
                      : <FlaskConical className="w-3 h-3 mr-1" />}
                    TEST GATE
                  </Button>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => { setEditGateOpen(false); setEditGate(null); setEditTestResult(null); }}
                    className="rounded-none border-primary/20 font-mono text-xs h-8">
                    Cancel
                  </Button>
                  <Button onClick={handleEditSave} disabled={updateGateMutation.isPending || !editGate?.name || !editGate?.gateType} size="sm"
                    className="rounded-none bg-primary text-black hover:bg-primary/90 font-display tracking-widest text-xs h-8 px-4">
                    {updateGateMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Save className="w-3 h-3 mr-1" />}
                    SAVE
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </Card>

        {/* Session cache + cooldown visibility */}
        <Card className="glass-panel rounded-none lg:col-span-3">
          <CardHeader className="border-b border-white/[0.06]">
            <div className="flex items-center justify-between">
              <CardTitle className="font-display tracking-widest text-sm flex items-center gap-2">
                <Database className="w-5 h-5 text-cyan-400" />
                Session Cache &amp; Cooldown
              </CardTitle>
              <Button onClick={() => clearSession()} size="sm" variant="outline"
                className="rounded-none border-red-500/30 text-red-400 hover:bg-red-500/10 font-mono text-[10px] h-7 px-2"
                disabled={!sessionData?.sessions?.length && !sessionData?.cooldowns?.length}>
                <X className="w-3 h-3 mr-1" /> CLEAR ALL
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/50 border-b border-primary/10 pb-1 mb-2">
                Cached Sessions ({sessionData?.sessions?.length || 0})
              </div>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {(sessionData?.sessions || []).map((s: any) => (
                  <div key={s.hostname} className="flex items-center gap-2 text-[10px] font-mono">
                    <span className="text-foreground/80 flex-1 truncate" title={s.hostname}>{s.hostname}</span>
                    <span className="text-muted-foreground/50">{s.ageSeconds}s</span>
                    {s.hasPublicKey && <span className="text-emerald-400" title="Has publishable key">pk</span>}
                    {s.hasConnectedAccount && <span className="text-yellow-400" title="Has connected account">acct</span>}
                    {s.nonceCount > 0 && <span className="text-cyan-400" title="Cached nonces">n{s.nonceCount}</span>}
                    <Button onClick={() => clearSession(s.hostname)} size="sm" variant="ghost" className="h-5 px-1 text-[10px] text-red-400 hover:bg-red-500/20">×</Button>
                  </div>
                ))}
                {!sessionData?.sessions?.length && <p className="text-[10px] font-mono text-muted-foreground/40 italic">No active sessions</p>}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/50 border-b border-primary/10 pb-1 mb-2">
                Site Cooldowns ({sessionData?.cooldowns?.length || 0})
              </div>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {(sessionData?.cooldowns || []).map((c: any) => (
                  <div key={c.hostname} className="flex items-center gap-2 text-[10px] font-mono">
                    <span className="text-foreground/80 flex-1 truncate" title={c.hostname}>{c.hostname}</span>
                    <span className="text-cyan-400" title="Checks in last 10 min">{c.checks10min}/10m</span>
                    <span className={c.blocks >= 3 ? "text-red-400" : c.blocks >= 1 ? "text-yellow-400" : "text-emerald-400"} title="Consecutive blocks">
                      {c.blocks > 0 ? `⚠${c.blocks}` : "✓"}
                    </span>
                  </div>
                ))}
                {!sessionData?.cooldowns?.length && <p className="text-[10px] font-mono text-muted-foreground/40 italic">No tracked sites</p>}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="glass-panel rounded-none lg:col-span-3">
          <CardHeader className="border-b border-white/[0.06]">
            <CardTitle className="font-display tracking-widest text-sm flex items-center gap-2">
              <Zap className="w-5 h-5 text-[hsl(45_100%_50%)]" />
              Global Engine Settings
            </CardTitle>
          </CardHeader>
          <CardContent className="p-6 grid grid-cols-1 md:grid-cols-3 gap-8">
            <div className="flex items-center justify-between">
              <div>
                <Label className="font-display tracking-wider text-sm">Parallel Mode</Label>
                <p className="text-xs font-mono text-muted-foreground mt-1">Simultaneous multi-config checks</p>
              </div>
              <Switch checked={settings?.parallelMode ?? true} onCheckedChange={(checked) => updateSettingsMutation.mutate({ parallelMode: checked })} className="data-[state=checked]:bg-primary" />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label className="font-display tracking-wider text-sm">Proxy File Output</Label>
                <p className="text-xs font-mono text-muted-foreground mt-1">Auto-send live proxies to channel</p>
              </div>
              <Switch checked={settings?.proxyFileOutput ?? true} onCheckedChange={(checked) => updateSettingsMutation.mutate({ proxyFileOutput: checked })} className="data-[state=checked]:bg-primary" />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label className="font-display tracking-wider text-sm">LSTM Auto-Train</Label>
                <p className="text-xs font-mono text-muted-foreground mt-1">Retrain every 5 lives</p>
              </div>
              <Switch checked={settings?.lstmAutoTrain ?? true} onCheckedChange={(checked) => updateSettingsMutation.mutate({ lstmAutoTrain: checked })} className="data-[state=checked]:bg-primary" />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
