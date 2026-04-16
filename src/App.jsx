import { useState, useReducer, useCallback, useMemo, useRef, useEffect } from "react";
import {
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartTooltip,
  ResponsiveContainer, Cell
} from "recharts";

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const PERSONAS = {
  youngGrad:    { label: "🎓 Young Graduate",      age: 23, income: 2800,  employment: "fullTime",    loanAmount: 15000, purpose: "education", creditScore: 620, bio: "Recent grad, entry-level job, thin credit history" },
  gigWorker:    { label: "🚗 Gig Worker",           age: 31, income: 2200,  employment: "selfEmployed",loanAmount: 8000,  purpose: "personal",  creditScore: 590, bio: "Ride-share + freelance, variable income" },
  seniorRetired:{ label: "👴 Senior Retiree",       age: 68, income: 3500,  employment: "retired",     loanAmount: 20000, purpose: "medical",   creditScore: 740, bio: "Pension income, strong credit, fixed expenses" },
  smallBiz:     { label: "🏪 Small Business Owner", age: 42, income: 6000,  employment: "selfEmployed",loanAmount: 50000, purpose: "business",  creditScore: 680, bio: "10yr business, strong revenue but variable" },
  singleParent: { label: "👩‍👧 Single Parent",        age: 35, income: 3200,  employment: "fullTime",    loanAmount: 12000, purpose: "home",      creditScore: 640, bio: "Stable job, childcare expenses reduce savings" },
  immigrant:    { label: "🌍 Recent Immigrant",      age: 29, income: 3800,  employment: "fullTime",    loanAmount: 18000, purpose: "home",      creditScore: 540, bio: "Employed, no US credit history yet" },
};

const EMPTY_FORM = { name: "", age: 30, income: 4000, employment: "fullTime", loanAmount: 20000, purpose: "home", creditScore: 680, gender: "", ethnicity: "" };

// ─── AI SCORING ENGINE ────────────────────────────────────────────────────────
function scoreApp({ age, income, employment, loanAmount, purpose, creditScore }, seed = Math.random()) {
  const lti = loanAmount / (income * 12);
  const csScore  = Math.min(40, Math.max(0, ((creditScore - 300) / 550) * 40));
  const empMap   = { fullTime: 25, partTime: 14, selfEmployed: 16, unemployed: 0, retired: 18 };
  const empScore = empMap[employment] || 0;
  const ltiScore = lti <= 2 ? 20 : lti <= 4 ? 12 : lti <= 6 ? 5 : 0;
  const purpMap  = { home: 10, education: 9, medical: 9, business: 7, vehicle: 8, personal: 5, other: 4 };
  const purpScore= purpMap[purpose] || 4;
  const ageScore = age >= 25 && age <= 60 ? 5 : age >= 21 ? 3 : 1;
  const raw = csScore + empScore + ltiScore + purpScore + ageScore;
  const noise = (seed - 0.5) * 4;
  const total = Math.max(0, Math.min(100, raw + noise));
  const decision = total >= 68 ? "approved" : total >= 45 ? "conditional" : "rejected";
  const confidence = Math.round(50 + Math.abs(total - 56.5) * 0.9);
  return {
    decision, score: total, confidence, lti,
    factors: {
      "Credit Score":    { value: Math.round(csScore),   max: 40 },
      "Income Stability":{ value: empScore,               max: 25 },
      "Loan/Income Ratio":{ value: ltiScore,              max: 20 },
      "Loan Purpose":    { value: purpScore,              max: 10 },
      "Applicant Profile":{ value: ageScore,              max: 5  },
    }
  };
}

function minViableChange(form) {
  const hints = [];
  const r = scoreApp(form, 0.5);
  if (r.decision !== "approved") {
    const neededScore = 68;
    const lti = form.loanAmount / (form.income * 12);
    if (lti > 2) {
      const targetLoan = form.income * 12 * 1.8;
      if (targetLoan < form.loanAmount) hints.push(`Reduce loan to $${Math.round(targetLoan).toLocaleString()} to improve ratio`);
      const targetIncome = form.loanAmount / (12 * 1.8);
      if (targetIncome > form.income) hints.push(`Increase monthly income by $${Math.round(targetIncome - form.income).toLocaleString()} to fix ratio`);
    }
    if (form.creditScore < 720) hints.push(`Raise credit score to ${Math.min(850, form.creditScore + 80)} (+${Math.min(80, 850 - form.creditScore)} pts) for major boost`);
    if (form.employment === "unemployed") hints.push("Any employment status significantly improves approval odds");
    if (form.employment === "partTime") hints.push("Moving to full-time employment adds ~11 points");
  }
  return hints.slice(0, 2);
}

// Bias grid: pre-compute 9 scenarios
function buildBiasGrid(baseLoanAmount, withDemographics = false) {
  const incomes = [2000, 4000, 7000];
  const employments = ["fullTime", "partTime", "selfEmployed"];
  const incomeLabels = ["Low ($2k/mo)", "Mid ($4k/mo)", "High ($7k/mo)"];
  const empLabels = ["Full-Time", "Part-Time", "Self-Employed"];
  return { incomeLabels, empLabels, cells: incomes.map((inc, ri) => employments.map((emp, ci) => {
    const base = scoreApp({ age: 35, income: inc, employment: emp, loanAmount: baseLoanAmount, purpose: "home", creditScore: 660 }, 0.5);
    const modifier = withDemographics ? (ci === 2 ? -4 : ri === 0 ? -2 : 0) : 0;
    const score = Math.max(0, Math.min(100, base.score + modifier));
    return { score: Math.round(score), decision: score >= 68 ? "approved" : score >= 45 ? "conditional" : "rejected" };
  }))};
}

// ─── STATE ────────────────────────────────────────────────────────────────────
const initState = {
  form: { ...EMPTY_FORM, name: "Applicant" },
  result: null,
  liveForm: { ...EMPTY_FORM, name: "Applicant" },
  liveResult: null,
  submitted: false,
  chatMessages: [],
  chatInput: "",
  chatLoading: false,
  trustRatings: [],
  showDemographics: false,
  biasWithDemo: false,
  auditTrail: [],
  activeModule: "form",
  apiKey: "",
  showApiKeyModal: true,
};

function reducer(state, action) {
  switch (action.type) {
    case "SET_FIELD": return { ...state, form: { ...state.form, [action.k]: action.v } };
    case "SET_LIVE_FIELD": {
      const lf = { ...state.liveForm, [action.k]: action.v };
      return { ...state, liveForm: lf, liveResult: scoreApp(lf) };
    }
    case "LOAD_PERSONA": {
      const p = PERSONAS[action.key];
      const f = { ...state.form, age: p.age, income: p.income, employment: p.employment, loanAmount: p.loanAmount, purpose: p.purpose, creditScore: p.creditScore };
      return { ...state, form: f, liveForm: f };
    }
    case "SUBMIT": {
      const result = scoreApp(state.form);
      const trail = [...state.auditTrail, { type: "DECISION", ts: Date.now(), data: { form: { ...state.form }, result } }];
      return { ...state, result, liveForm: { ...state.form }, liveResult: result, submitted: true, activeModule: "result", auditTrail: trail };
    }
    case "ADD_CHAT": return { ...state, chatMessages: [...state.chatMessages, action.msg] };
    case "SET_CHAT_INPUT": return { ...state, chatInput: action.v };
    case "SET_CHAT_LOADING": return { ...state, chatLoading: action.v };
    case "ADD_TRUST": {
      const tr = [...state.trustRatings, { q: action.question, r: action.rating, ts: Date.now() }];
      const trail = [...state.auditTrail, { type: "TRUST_RATING", ts: Date.now(), data: { question: action.question, rating: action.rating } }];
      return { ...state, trustRatings: tr, auditTrail: trail };
    }
    case "TOGGLE_DEMO": return { ...state, showDemographics: !state.showDemographics };
    case "TOGGLE_BIAS_DEMO": return { ...state, biasWithDemo: !state.biasWithDemo };
    case "SET_MODULE": return { ...state, activeModule: action.v };
    case "SET_API_KEY": return { ...state, apiKey: action.v };
    case "CLOSE_MODAL": return { ...state, showApiKeyModal: false };
    case "RESET": return { ...initState, apiKey: state.apiKey, showApiKeyModal: false };
    default: return state;
  }
}

// ─── UTIL COMPONENTS ──────────────────────────────────────────────────────────
function HCIBadge({ label }) {
  return <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 border border-indigo-200">🔬 {label}</span>;
}

function ModuleBadge({ n }) {
  return <span className="w-6 h-6 rounded-full bg-indigo-600 text-white text-xs font-bold flex items-center justify-center flex-shrink-0">{n}</span>;
}

function DecisionPill({ decision }) {
  const cfg = { approved: "bg-emerald-100 text-emerald-700 border-emerald-300", conditional: "bg-amber-100 text-amber-700 border-amber-300", rejected: "bg-red-100 text-red-700 border-red-300" };
  const icons = { approved: "✅", conditional: "⚠️", rejected: "❌" };
  const labels = { approved: "Approved", conditional: "Review Needed", rejected: "Declined" };
  return <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border font-semibold text-sm ${cfg[decision]}`}>{icons[decision]} {labels[decision]}</span>;
}

function TipTooltip({ tip, children }) {
  const [show, setShow] = useState(false);
  return (
    <span className="relative inline-block">
      <span onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>{children}</span>
      {show && <span className="absolute z-50 bottom-full left-0 mb-1.5 w-56 text-xs bg-slate-800 text-white rounded-lg px-3 py-2 shadow-xl pointer-events-none whitespace-normal">{tip}<span className="absolute top-full left-4 border-4 border-transparent border-t-slate-800" /></span>}
    </span>
  );
}

function ScoreBar({ score, animated = true }) {
  const color = score >= 68 ? "#22c55e" : score >= 45 ? "#f59e0b" : "#ef4444";
  const [width, setWidth] = useState(animated ? 0 : score);
  useEffect(() => { if (animated) { setTimeout(() => setWidth(score), 100); } }, [score]);
  return (
    <div className="relative h-3 bg-slate-100 rounded-full overflow-hidden">
      <div className="absolute inset-0 flex">
        <div className="h-full bg-red-200 flex-1" style={{ maxWidth: "45%" }} />
        <div className="h-full bg-amber-200 flex-1" style={{ maxWidth: "23%" }} />
        <div className="h-full bg-emerald-200 flex-1" />
      </div>
      <div className="absolute top-0 left-0 h-full rounded-full transition-all duration-700 ease-out" style={{ width: `${width}%`, background: color }} />
    </div>
  );
}

function TrustWidget({ question, onRate }) {
  const [rated, setRated] = useState(null);
  return (
    <div className="mt-3 flex items-center gap-2 flex-wrap">
      <span className="text-xs text-slate-500">Trust this explanation?</span>
      {[1, 2, 3, 4, 5].map(n => (
        <button key={n} onClick={() => { setRated(n); onRate(question, n); }}
          className={`text-lg transition-transform hover:scale-125 ${rated && n <= rated ? "opacity-100" : "opacity-30"}`}>⭐</button>
      ))}
      {rated && <span className="text-xs text-indigo-600 font-medium">Logged ✓</span>}
    </div>
  );
}

// ─── CLAUDE API CALL ──────────────────────────────────────────────────────────
async function askGroq(apiKey, systemPrompt, messages) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        ...messages
      ],
      temperature: 0.3,
      max_tokens: 300
    })
  });

  const data = await res.json();

  if (data.error) {
    throw new Error(data.error.message);
  }

  return data.choices?.[0]?.message?.content || 
    "Sorry, I couldn't generate a response.";
}

// ─── MODULE 1: FORM ───────────────────────────────────────────────────────────
function FormModule({ state, dispatch }) {
  const { form, showDemographics } = state;
  const f = (k, v) => dispatch({ type: "SET_FIELD", k, v });
  const inputCls = "w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm text-slate-800 bg-white focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all";
  return (
    <div className="card p-6 fade-in">
      <div className="flex items-center gap-3 mb-5">
        <ModuleBadge n="1" />
        <div>
          <h2 className="font-bold text-slate-800 text-lg" style={{ fontFamily: "'Sora',sans-serif" }}>Loan Application</h2>
          <p className="text-xs text-slate-400">Complete the form or load a research persona</p>
        </div>
      </div>

      {/* Persona Loader */}
      <div className="mb-5 p-4 bg-indigo-50 rounded-2xl border border-indigo-100">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-indigo-700 uppercase tracking-wide">Load Research Persona</span>
          <HCIBadge label="Bias Testing" />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {Object.entries(PERSONAS).map(([key, p]) => (
            <button key={key} onClick={() => dispatch({ type: "LOAD_PERSONA", key })}
              className="text-left p-2.5 bg-white rounded-xl border border-indigo-100 hover:border-indigo-300 hover:bg-indigo-50 transition-all">
              <div className="text-sm font-medium text-slate-700">{p.label}</div>
              <div className="text-xs text-slate-400 mt-0.5 leading-tight">{p.bio}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">Full Name</label>
          <input type="text" value={form.name} onChange={e => f("name", e.target.value)} className={inputCls} placeholder="Jane Smith" />
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">Age</label>
          <input type="number" value={form.age} onChange={e => f("age", +e.target.value)} className={inputCls} min={18} max={100} />
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">Monthly Income (USD)</label>
          <div className="relative"><span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
            <input type="number" value={form.income} onChange={e => f("income", +e.target.value)} className={inputCls + " pl-7"} />
          </div>
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">Employment Status</label>
          <select value={form.employment} onChange={e => f("employment", e.target.value)} className={inputCls}>
            <option value="fullTime">Full-Time Employed</option>
            <option value="partTime">Part-Time Employed</option>
            <option value="selfEmployed">Self-Employed</option>
            <option value="retired">Retired</option>
            <option value="unemployed">Unemployed</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">Loan Amount</label>
          <div className="relative"><span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
            <input type="number" value={form.loanAmount} onChange={e => f("loanAmount", +e.target.value)} className={inputCls + " pl-7"} />
          </div>
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">Loan Purpose</label>
          <select value={form.purpose} onChange={e => f("purpose", e.target.value)} className={inputCls}>
            <option value="home">Home Purchase</option>
            <option value="vehicle">Vehicle</option>
            <option value="education">Education</option>
            <option value="medical">Medical</option>
            <option value="business">Business</option>
            <option value="personal">Personal</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className="block text-xs font-semibold text-slate-600 mb-1.5 uppercase tracking-wide flex justify-between">
            <span>Credit Score <TipTooltip tip="300–850. Above 720 = excellent. Below 580 = poor. This is the biggest single factor."><span className="text-slate-400 cursor-help">ⓘ</span></TipTooltip></span>
            <span className={`font-bold ${form.creditScore >= 720 ? "text-emerald-600" : form.creditScore >= 580 ? "text-amber-600" : "text-red-600"}`}>{form.creditScore}</span>
          </label>
          <input type="range" min={300} max={850} value={form.creditScore} onChange={e => f("creditScore", +e.target.value)} className="w-full" />
          <div className="flex justify-between text-xs text-slate-400 mt-1"><span>300 Poor</span><span>580 Fair</span><span>720 Excellent</span><span>850</span></div>
        </div>
      </div>

      {/* Demographics Toggle */}
      <div className="mt-4 border-t border-dashed border-slate-200 pt-4">
        <button onClick={() => dispatch({ type: "TOGGLE_DEMO" })} className="flex items-center gap-2 text-sm text-slate-500 hover:text-indigo-600 transition-colors">
          <span className={`w-8 h-4 rounded-full flex items-center px-0.5 transition-colors ${showDemographics ? "bg-indigo-500" : "bg-slate-300"}`}>
            <span className={`w-3 h-3 rounded-full bg-white shadow transition-transform ${showDemographics ? "translate-x-4" : ""}`} />
          </span>
          <span>Show demographic fields <span className="text-xs text-slate-400">(used in Bias Audit module)</span></span>
        </button>
        {showDemographics && (
          <div className="grid grid-cols-2 gap-4 mt-3">
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">Gender <span className="text-slate-300">(optional)</span></label>
              <select value={form.gender} onChange={e => f("gender", e.target.value)} className={inputCls}>
                <option value="">Prefer not to say</option><option value="male">Male</option><option value="female">Female</option><option value="nonbinary">Non-binary</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">Ethnicity <span className="text-slate-300">(optional)</span></label>
              <select value={form.ethnicity} onChange={e => f("ethnicity", e.target.value)} className={inputCls}>
                <option value="">Prefer not to say</option><option value="white">White</option><option value="black">Black/African American</option><option value="hispanic">Hispanic/Latino</option><option value="asian">Asian</option><option value="other">Other</option>
              </select>
            </div>
            <div className="col-span-2 text-xs text-slate-400 bg-slate-50 rounded-xl p-3">⚠️ These fields are shown for research purposes only. Toggle the Bias Audit module to see if demographic data changes outcomes — our model does <strong>not</strong> use this data in decisions.</div>
          </div>
        )}
      </div>

      <button onClick={() => dispatch({ type: "SUBMIT" })} className="btn-primary w-full mt-6">
        Submit for AI Review →
      </button>
    </div>
  );
}

// ─── MODULE 2: WHAT-IF NEGOTIATION ────────────────────────────────────────────
function WhatIfModule({ state, dispatch }) {
  const { liveForm, liveResult, result } = state;
  const timerRef = useRef(null);

  const debouncedUpdate = useCallback((k, v) => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => dispatch({ type: "SET_LIVE_FIELD", k, v }), 400);
  }, [dispatch]);

  const hints = useMemo(() => liveResult ? minViableChange(liveForm) : [], [liveForm, liveResult]);
  if (!result) return null;

  const scoreColor = liveResult?.score >= 68 ? "#22c55e" : liveResult?.score >= 45 ? "#f59e0b" : "#ef4444";

  return (
    <div className="card p-6 fade-in">
      <div className="flex items-center justify-between mb-5 flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <ModuleBadge n="2" />
          <div>
            <h2 className="font-bold text-slate-800 text-lg" style={{ fontFamily: "'Sora',sans-serif" }}>What-If Negotiation</h2>
            <p className="text-xs text-slate-400">Drag sliders to see how changes affect your decision</p>
          </div>
        </div>
        <HCIBadge label="Direct Manipulation" />
      </div>

      {/* Live outcome bar */}
      <div className="mb-5 p-4 bg-slate-50 rounded-2xl border border-slate-100">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-semibold text-slate-700">Live Outcome Score</span>
          {liveResult && <DecisionPill decision={liveResult.decision} />}
        </div>
        {liveResult && <ScoreBar score={liveResult.score} />}
        <div className="flex justify-between text-xs text-slate-400 mt-1">
          <span>Rejected &lt;45</span><span>Review 45–67</span><span>Approved ≥68</span>
          <span className="font-bold" style={{ color: scoreColor }}>{liveResult ? Math.round(liveResult.score) : 0}/100</span>
        </div>
      </div>

      {/* Sliders */}
      <div className="space-y-5">
        {[
          { k: "creditScore", label: "Credit Score", min: 300, max: 850, step: 10, fmt: v => v, tip: "The largest factor — 40% of total score" },
          { k: "income", label: "Monthly Income ($)", min: 500, max: 20000, step: 100, fmt: v => `$${v.toLocaleString()}`, tip: "Affects loan-to-income ratio" },
          { k: "loanAmount", label: "Loan Amount ($)", min: 1000, max: 200000, step: 1000, fmt: v => `$${v.toLocaleString()}`, tip: "Lower amount = better ratio" },
          { k: "age", label: "Age", min: 18, max: 80, step: 1, fmt: v => v + " yrs", tip: "Minor factor — ages 25–60 score highest" },
        ].map(({ k, label, min, max, step, fmt, tip }) => (
          <div key={k}>
            <div className="flex justify-between items-center mb-1.5">
              <label className="text-xs font-semibold text-slate-600 uppercase tracking-wide">
                {label} <TipTooltip tip={tip}><span className="text-slate-400 cursor-help">ⓘ</span></TipTooltip>
              </label>
              <span className="text-sm font-bold text-indigo-600">{fmt(liveForm[k])}</span>
            </div>
            <input type="range" min={min} max={max} step={step} defaultValue={liveForm[k]}
              onChange={e => debouncedUpdate(k, +e.target.value)} className="w-full slider-vivid" />
          </div>
        ))}
        <div>
          <label className="text-xs font-semibold text-slate-600 uppercase tracking-wide block mb-1.5">Employment</label>
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
            {[["fullTime","Full-Time"],["partTime","Part-Time"],["selfEmployed","Self-Emp"],["retired","Retired"],["unemployed","Unemployed"]].map(([v, l]) => (
              <button key={v} onClick={() => dispatch({ type: "SET_LIVE_FIELD", k: "employment", v })}
                className={`text-xs py-2 px-2 rounded-xl border font-medium transition-all ${liveForm.employment === v ? "border-indigo-400 bg-indigo-50 text-indigo-700" : "border-slate-200 text-slate-500 hover:border-indigo-200"}`}>{l}</button>
            ))}
          </div>
        </div>
      </div>

      {/* Minimum viable change hints */}
      {hints.length > 0 && (
        <div className="mt-4 space-y-2">
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide">💡 Minimum Viable Changes</div>
          {hints.map((h, i) => (
            <div key={i} className="flex items-start gap-2 p-3 bg-amber-50 rounded-xl border border-amber-100 text-sm text-amber-800">
              <span className="text-amber-500 mt-0.5">→</span>{h}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── MODULE 3: CHATBOT ────────────────────────────────────────────────────────
function ChatModule({ state, dispatch }) {
  const { result, form, chatMessages, chatInput, chatLoading, apiKey, trustRatings } = state;
  const endRef = useRef(null);
  const avgTrust = trustRatings.length ? (trustRatings.reduce((s, r) => s + r.rating, 0) / trustRatings.length).toFixed(1) : null;

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chatMessages]);

  if (!result) return null;

  const systemPrompt = `You are a transparent AI loan advisor explaining a lending decision. 
Applicant: ${form.name}, Age ${form.age}, $${form.income}/mo income, ${form.employment}, credit score ${form.creditScore}.
Loan: $${form.loanAmount.toLocaleString()} for ${form.purpose}.
Decision: ${result.decision.toUpperCase()} (score: ${Math.round(result.score)}/100, confidence: ${result.confidence}%).
Factors: ${Object.entries(result.factors).map(([k, v]) => `${k}: ${v.value}/${v.max}`).join(", ")}.
IMPORTANT: Be concise (3–5 sentences max), plain English, no jargon. Be honest. Reference actual values above. If asked about fairness, acknowledge model limitations openly.`;

  const CHIPS = ["Why was I rejected?", "What matters most?", "Is this fair?", "How do I improve?"];

  async function send(text) {
    if (!text.trim() || chatLoading) return;
    const userMsg = { role: "user", content: text };
    dispatch({ type: "ADD_CHAT", msg: { ...userMsg, id: Date.now() } });
    dispatch({ type: "SET_CHAT_INPUT", v: "" });
    dispatch({ type: "SET_CHAT_LOADING", v: true });
    try {
      const history = [...chatMessages, userMsg].map(m => ({ role: m.role, content: m.content }));
      const reply = await askGroq(apiKey, systemPrompt, history);
      dispatch({ type: "ADD_CHAT", msg: { role: "assistant", content: reply, id: Date.now() + 1 } });
    } catch (e) {
      dispatch({ type: "ADD_CHAT", msg: { role: "assistant", content: `Error: ${e.message}. Check your API key in settings.`, id: Date.now() + 1 } });
    }
    dispatch({ type: "SET_CHAT_LOADING", v: false });
  }

  return (
    <div className="card p-6 fade-in">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <ModuleBadge n="3" />
          <div>
            <h2 className="font-bold text-slate-800 text-lg" style={{ fontFamily: "'Sora',sans-serif" }}>AI Reasoning Chat</h2>
            <p className="text-xs text-slate-400">Ask questions about your decision in plain English</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {avgTrust && <span className="text-xs text-slate-500">Trust Score: <strong className="text-indigo-600">{avgTrust}/5</strong></span>}
          <HCIBadge label="Conversational Transparency" />
        </div>
      </div>

      {/* Quick chips */}
      <div className="flex flex-wrap gap-2 mb-4">
        {CHIPS.map(c => (
          <button key={c} onClick={() => send(c)} className="text-xs px-3 py-1.5 bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-full hover:bg-indigo-100 transition-colors font-medium">{c}</button>
        ))}
      </div>

      {/* Messages */}
      <div className="h-64 overflow-y-auto bg-slate-50 rounded-2xl p-4 space-y-3 mb-3">
        {chatMessages.length === 0 && (
          <div className="text-center text-slate-400 text-sm pt-8">
            <div className="text-3xl mb-2">💬</div>
            Ask a question or tap a chip above
          </div>
        )}
        {chatMessages.map(m => (
          <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-xs lg:max-w-sm rounded-2xl px-4 py-3 text-sm ${m.role === "user" ? "bg-indigo-600 text-white rounded-br-sm" : "bg-white border border-slate-200 text-slate-700 rounded-bl-sm shadow-sm"}`}>
              {m.content}
              {m.role === "assistant" && <TrustWidget question={m.content.slice(0, 40)} onRate={(q, r) => dispatch({ type: "ADD_TRUST", question: q, rating: r })} />}
            </div>
          </div>
        ))}
        {chatLoading && (
          <div className="flex justify-start">
            <div className="bg-white border border-slate-200 rounded-2xl rounded-bl-sm px-4 py-3 shadow-sm">
              <div className="flex gap-1">{[0, 1, 2].map(i => <span key={i} className="w-2 h-2 bg-slate-300 rounded-full animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />)}</div>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="flex gap-2">
        <input value={chatInput} onChange={e => dispatch({ type: "SET_CHAT_INPUT", v: e.target.value })}
          onKeyDown={e => e.key === "Enter" && send(chatInput)}
          placeholder="Ask about your decision..." className="flex-1 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all" />
        <button onClick={() => send(chatInput)} disabled={chatLoading} className="btn-primary px-4 py-2.5 text-sm disabled:opacity-50">Send</button>
      </div>
    </div>
  );
}

// ─── MODULE 4: BIAS AUDIT ─────────────────────────────────────────────────────
function BiasAuditModule({ state, dispatch }) {
  const { biasWithDemo, result, form } = state;
  if (!result) return null;
  const grid = buildBiasGrid(form.loanAmount, biasWithDemo);
  const cellColor = (d) => d === "approved" ? "#dcfce7" : d === "conditional" ? "#fef9c3" : "#fee2e2";
  const textColor = (d) => d === "approved" ? "#15803d" : d === "conditional" ? "#92400e" : "#b91c1c";
  const scoreColor = (s) => s >= 68 ? "#16a34a" : s >= 45 ? "#d97706" : "#dc2626";

  return (
    <div className="card p-6 fade-in">
      <div className="flex items-center justify-between mb-5 flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <ModuleBadge n="4" />
          <div>
            <h2 className="font-bold text-slate-800 text-lg" style={{ fontFamily: "'Sora',sans-serif" }}>Bias Audit Heatmap</h2>
            <p className="text-xs text-slate-400">Approval rates across income × employment combinations</p>
          </div>
        </div>
        <HCIBadge label="Algorithmic Accountability" />
      </div>

      <div className="flex items-center gap-3 mb-4">
        <button onClick={() => dispatch({ type: "TOGGLE_BIAS_DEMO" })}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl border text-sm font-medium transition-all ${biasWithDemo ? "bg-red-50 border-red-300 text-red-700" : "bg-slate-50 border-slate-200 text-slate-600 hover:border-indigo-200"}`}>
          <span className={`w-8 h-4 rounded-full flex items-center px-0.5 ${biasWithDemo ? "bg-red-400" : "bg-slate-300"}`}>
            <span className={`w-3 h-3 rounded-full bg-white shadow transition-transform ${biasWithDemo ? "translate-x-4" : ""}`} />
          </span>
          {biasWithDemo ? "Demographic data ON" : "Demographic data OFF"}
        </button>
        {biasWithDemo && <span className="text-xs text-red-600 font-medium">⚠️ Showing simulated bias when demographics included</span>}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className="text-left text-xs text-slate-400 font-medium p-2 w-32">Income ↓ / Emp →</th>
              {grid.empLabels.map(l => <th key={l} className="text-center text-xs font-semibold text-slate-600 p-2">{l}</th>)}
            </tr>
          </thead>
          <tbody>
            {grid.cells.map((row, ri) => (
              <tr key={ri}>
                <td className="text-xs font-semibold text-slate-600 p-2">{grid.incomeLabels[ri]}</td>
                {row.map((cell, ci) => (
                  <td key={ci} className="p-1.5">
                    <div className="rounded-xl p-3 text-center transition-all" style={{ background: cellColor(cell.decision) }}>
                      <div className="font-bold text-base" style={{ color: scoreColor(cell.score) }}>{cell.score}</div>
                      <div className="text-xs mt-0.5 font-medium" style={{ color: textColor(cell.decision) }}>
                        {cell.decision === "approved" ? "✅ Appvd" : cell.decision === "conditional" ? "⚠️ Review" : "❌ Decl"}
                      </div>
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 p-3 bg-slate-50 rounded-xl text-xs text-slate-500 leading-relaxed">
        <strong className="text-slate-700">Research note:</strong> This grid pre-computes 9 income × employment scenarios holding all other variables constant (age=35, credit=660, loan=$<span>{form.loanAmount.toLocaleString()}</span>). Toggle demographic data to observe simulated bias effects — a key research question in algorithmic fairness.
      </div>
    </div>
  );
}

// ─── MODULE 5: TRUST CALIBRATION ─────────────────────────────────────────────
function TrustCalibrationModule({ state }) {
  const { trustRatings, result } = state;
  if (!result) return null;
  const avg = trustRatings.length ? trustRatings.reduce((s, r) => s + r.rating, 0) / trustRatings.length : 0;
  const byQ = trustRatings.slice(-6);

  return (
    <div className="card p-6 fade-in">
      <div className="flex items-center justify-between mb-5 flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <ModuleBadge n="5" />
          <div>
            <h2 className="font-bold text-slate-800 text-lg" style={{ fontFamily: "'Sora',sans-serif" }}>Trust Calibration</h2>
            <p className="text-xs text-slate-400">Tracking user trust in AI explanations over session</p>
          </div>
        </div>
        <HCIBadge label="Trust Calibration" />
      </div>

      <div className="grid grid-cols-3 gap-4 mb-5">
        <div className="text-center p-4 bg-indigo-50 rounded-2xl">
          <div className="text-3xl font-bold text-indigo-600" style={{ fontFamily: "'Sora',sans-serif" }}>{avg ? avg.toFixed(1) : "—"}</div>
          <div className="text-xs text-slate-500 mt-1">Avg Trust Score</div>
        </div>
        <div className="text-center p-4 bg-slate-50 rounded-2xl">
          <div className="text-3xl font-bold text-slate-700" style={{ fontFamily: "'Sora',sans-serif" }}>{trustRatings.length}</div>
          <div className="text-xs text-slate-500 mt-1">Total Ratings</div>
        </div>
        <div className="text-center p-4 bg-slate-50 rounded-2xl">
          <div className="text-3xl font-bold text-slate-700" style={{ fontFamily: "'Sora',sans-serif" }}>
            {avg >= 4 ? "🟢" : avg >= 3 ? "🟡" : avg > 0 ? "🔴" : "—"}
          </div>
          <div className="text-xs text-slate-500 mt-1">{avg >= 4 ? "High Trust" : avg >= 3 ? "Moderate" : avg > 0 ? "Low Trust" : "No data"}</div>
        </div>
      </div>

      {byQ.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Recent Ratings</div>
          <div className="space-y-2">
            {byQ.map((r, i) => (
              <div key={i} className="flex items-center justify-between py-2 border-b border-slate-100">
                <span className="text-xs text-slate-500 truncate max-w-xs">{r.q}…</span>
                <span className="text-sm flex-shrink-0">{"⭐".repeat(r.rating)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {trustRatings.length === 0 && (
        <div className="text-center text-slate-400 text-sm py-6">Rate AI explanations in the chat module to populate this panel.</div>
      )}
    </div>
  );
}

// ─── MODULE 6: AUDIT TRAIL ────────────────────────────────────────────────────
function AuditTrailModule({ state }) {
  const { auditTrail, result } = state;
  const [open, setOpen] = useState(false);
  if (!result) return null;

  function download() {
    const blob = new Blob([JSON.stringify(auditTrail, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = `loanlens-audit-${Date.now()}.json`; a.click();
  }

  function shareText() {
    const r = auditTrail.find(t => t.type === "DECISION");
    if (!r) return;
    const txt = `LoanLens Decision Summary\nApplicant: ${r.data.form.name}\nDecision: ${r.data.result.decision.toUpperCase()}\nScore: ${Math.round(r.data.result.score)}/100\nConfidence: ${r.data.result.confidence}%\nGenerated: ${new Date().toLocaleString()}`;
    navigator.clipboard.writeText(txt).then(() => alert("Copied to clipboard!"));
  }

  return (
    <div className="card fade-in overflow-hidden">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between p-5 hover:bg-slate-50 transition-colors">
        <div className="flex items-center gap-3">
          <ModuleBadge n="6" />
          <div className="text-left">
            <h2 className="font-bold text-slate-800" style={{ fontFamily: "'Sora',sans-serif" }}>Session Audit Trail</h2>
            <p className="text-xs text-slate-400">{auditTrail.length} events recorded</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <HCIBadge label="Transparency" />
          <span className={`text-slate-400 transition-transform ${open ? "rotate-180" : ""}`}>▼</span>
        </div>
      </button>

      {open && (
        <div className="px-5 pb-5">
          <div className="flex gap-2 mb-4">
            <button onClick={download} className="btn-secondary text-xs px-3 py-1.5">⬇ Download JSON</button>
            <button onClick={shareText} className="btn-secondary text-xs px-3 py-1.5">📋 Copy Summary</button>
          </div>
          <div className="max-h-64 overflow-y-auto space-y-2">
            {auditTrail.map((ev, i) => (
              <div key={i} className="flex gap-3 p-3 bg-slate-50 rounded-xl text-xs">
                <span className="text-slate-400 flex-shrink-0 font-mono">{new Date(ev.ts).toLocaleTimeString()}</span>
                <span className={`font-semibold flex-shrink-0 ${ev.type === "DECISION" ? "text-indigo-600" : ev.type === "TRUST_RATING" ? "text-emerald-600" : "text-slate-600"}`}>{ev.type}</span>
                <span className="text-slate-500 truncate">{ev.type === "DECISION" ? `Score: ${Math.round(ev.data.result.score)} → ${ev.data.result.decision}` : ev.type === "TRUST_RATING" ? `"${ev.data.question}" → ${ev.data.rating}★` : JSON.stringify(ev.data).slice(0, 60)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── DECISION SUMMARY PANEL ───────────────────────────────────────────────────
function DecisionPanel({ result, form }) {
  if (!result) return null;
  const cfg = { approved: { bg: "from-emerald-50 to-white border-emerald-200", icon: "✅", color: "text-emerald-700" }, conditional: { bg: "from-amber-50 to-white border-amber-200", icon: "⚠️", color: "text-amber-700" }, rejected: { bg: "from-red-50 to-white border-red-200", icon: "❌", color: "text-red-700" } }[result.decision];
  const chartData = Object.entries(result.factors).map(([k, v]) => ({ name: k, value: v.value, max: v.max, pct: Math.round((v.value / v.max) * 100) }));

  return (
    <div className={`card p-6 border-2 bg-gradient-to-b ${cfg.bg} fade-in`}>
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <div className="text-4xl mb-1">{cfg.icon}</div>
          <h2 className={`text-2xl font-bold ${cfg.color}`} style={{ fontFamily: "'Sora',sans-serif" }}>
            {result.decision === "approved" ? "Approved" : result.decision === "conditional" ? "Review Needed" : "Declined"}
          </h2>
          <p className="text-sm text-slate-500 mt-1">{form.name} · ${Number(form.loanAmount).toLocaleString()} · Score: {Math.round(result.score)}/100</p>
        </div>
        <div className="text-center flex-shrink-0">
          <div className="text-3xl font-bold text-indigo-600">{result.confidence}%</div>
          <div className="text-xs text-slate-400">Confidence</div>
        </div>
      </div>

      <ScoreBar score={result.score} />
      <div className="mt-4">
        <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Factor Breakdown</div>
        <ResponsiveContainer width="100%" height={150}>
          <BarChart data={chartData} layout="vertical" margin={{ left: 0, right: 30 }}>
            <XAxis type="number" domain={[0, 40]} tick={{ fontSize: 10 }} />
            <YAxis dataKey="name" type="category" width={110} tick={{ fontSize: 10 }} />
            <RechartTooltip formatter={(v, n, p) => [`${v}/${p.payload.max} pts`, "Score"]} />
            <Bar dataKey="value" radius={[0, 6, 6, 0]} maxBarSize={16}>
              {chartData.map((e, i) => <Cell key={i} fill={e.pct >= 75 ? "#22c55e" : e.pct >= 40 ? "#f59e0b" : "#ef4444"} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ─── API KEY MODAL ────────────────────────────────────────────────────────────
function ApiKeyModal({ state, dispatch }) {
  const [key, setKey] = useState("");
  if (!state.showApiKeyModal) return null;
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl p-6 max-w-md w-full shadow-2xl">
        <div className="text-2xl mb-2">🔑</div>
        <h2 className="font-bold text-slate-800 text-lg mb-1" style={{ fontFamily: "'Sora',sans-serif" }}>GROQ API Key</h2>
        <p className="text-sm text-slate-500 mb-4">Required for the AI Reasoning Chat module (Module 3). All other modules work without it.</p>
        <input type="password" value={key} onChange={e => setKey(e.target.value)} placeholder="gsk_..." className="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm mb-3 focus:outline-none focus:border-indigo-400" />
        <div className="text-xs text-slate-400 mb-4">Your key is stored in memory only and never sent anywhere except GROQ's API directly from your browser.</div>
        <div className="flex gap-2">
          <button onClick={() => { dispatch({ type: "SET_API_KEY", v: key }); dispatch({ type: "CLOSE_MODAL" }); }} className="btn-primary flex-1 text-sm">
            Save & Continue
          </button>
          <button onClick={() => dispatch({ type: "CLOSE_MODAL" })} className="btn-secondary text-sm px-4">
            Skip
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── MAIN APP ──────────────────────────────────────────────────────────────────
export default function App() {
  const [state, dispatch] = useReducer(reducer, initState);
  const avgTrust = state.trustRatings.length ? (state.trustRatings.reduce((s, r) => s + r.rating, 0) / state.trustRatings.length).toFixed(1) : null;

  return (
    <div className="min-h-screen bg-slate-50" style={{ fontFamily: "'DM Sans','Segoe UI',system-ui,sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=Sora:wght@600;700;800&display=swap');
        *{box-sizing:border-box}
        .card{background:white;border-radius:1.25rem;box-shadow:0 1px 3px rgba(0,0,0,.06),0 4px 16px rgba(0,0,0,.04)}
        .btn-primary{background:linear-gradient(135deg,#4f46e5,#6366f1);color:white;border:none;border-radius:.875rem;padding:.75rem 1.5rem;font-weight:600;font-size:.9rem;cursor:pointer;transition:all .2s;box-shadow:0 4px 14px rgba(79,70,229,.3)}
        .btn-primary:hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(79,70,229,.4)}
        .btn-secondary{background:white;border:1.5px solid #e2e8f0;color:#475569;border-radius:.875rem;padding:.625rem 1.25rem;font-weight:500;cursor:pointer;transition:all .2s;font-size:.875rem}
        .btn-secondary:hover{border-color:#c7d2fe;background:#f8f7ff}
        input:focus,select:focus{outline:none}
        .fade-in{animation:fadeIn .35s ease}
        @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        input[type=range]{-webkit-appearance:none;appearance:none;height:6px;border-radius:3px;background:linear-gradient(to right,#4f46e5 0%,#e2e8f0 0%);cursor:pointer}
        input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;background:#4f46e5;border-radius:50%;border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,.2)}
        .slider-vivid{accent-color:#4f46e5}
        @keyframes bounce{0%,80%,100%{transform:translateY(0)}40%{transform:translateY(-6px)}}
        .animate-bounce{animation:bounce 1s infinite}
      `}</style>

      <ApiKeyModal state={state} dispatch={dispatch} />

      {/* Header */}
      <header style={{ background: "linear-gradient(135deg,#0f0c29 0%,#1e1b4b 50%,#312e81 100%)" }} className="px-4 py-4 sticky top-0 z-40">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-white/10 flex items-center justify-center text-xl">🔍</div>
            <div>
              <div style={{ fontFamily: "'Sora',sans-serif" }} className="text-white font-bold text-xl leading-tight">LoanLens</div>
              <div className="text-indigo-300 text-xs">HCI Research Prototype · Transparent AI Lending</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {avgTrust && (
              <div className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 bg-white/10 rounded-xl">
                <span className="text-yellow-300 text-sm">⭐</span>
                <span className="text-white text-xs font-semibold">Trust: {avgTrust}/5</span>
              </div>
            )}
            <button onClick={() => dispatch({ type: "RESET" })} className="text-indigo-300 hover:text-white text-xs border border-white/20 rounded-xl px-3 py-1.5 transition-colors">
              Reset
            </button>
            <button onClick={() => dispatch({ type: "SET_MODULE", v: "form" })} className="text-indigo-300 hover:text-white text-xs border border-white/20 rounded-xl px-3 py-1.5 transition-colors">
              ← Form
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-4 py-6">
        {!state.submitted ? (
          <FormModule state={state} dispatch={dispatch} />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            {/* Left col: Decision + What-If */}
            <div className="lg:col-span-1 space-y-5">
              <DecisionPanel result={state.result} form={state.form} />
              <WhatIfModule state={state} dispatch={dispatch} />
            </div>
            {/* Right col: Chat + Bias + Trust + Audit */}
            <div className="lg:col-span-2 space-y-5">
              <ChatModule state={state} dispatch={dispatch} />
              <BiasAuditModule state={state} dispatch={dispatch} />
              <TrustCalibrationModule state={state} />
              <AuditTrailModule state={state} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
