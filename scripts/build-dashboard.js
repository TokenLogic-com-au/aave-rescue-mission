const fs = require("fs");
const path = require("path");

const rootCachePath = path.resolve(__dirname, "../balances-cache.json");
const docsDataDir = path.resolve(__dirname, "../docs/data");
const balancesCachePath = path.resolve(docsDataDir, "balances-cache.json");

if (fs.existsSync(rootCachePath)) {
  if (!fs.existsSync(docsDataDir)) {
    fs.mkdirSync(docsDataDir, { recursive: true });
  }
  fs.copyFileSync(rootCachePath, balancesCachePath);
}

if (!fs.existsSync(balancesCachePath)) {
  console.error(
    `balances-cache.json not found at ${balancesCachePath} or ${rootCachePath}`
  );
  process.exit(1);
}

const balancesCacheRaw = fs.readFileSync(balancesCachePath, "utf8");
const balancesCacheMin = JSON.stringify(JSON.parse(balancesCacheRaw));

const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Aave V3 & V4 — Balances & Surplus Dashboard | TokenLogic</title>
  <meta name="description" content="Aave V3 & V4: Interactive Balances, Surplus, and Stuck Token Dashboard across 21 EVM Networks." />
  <link rel="icon" href="https://www.tokenlogic.xyz/figma/imagotype.svg" type="image/svg+xml" />

  <!-- Inter font -->
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />

  <!-- Tailwind CSS CDN -->
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            /* TokenLogic design system tokens — Day / Bright mode values */
            tl: {
              /* bg tokens */
              'bg-base':       '#ffffff',  /* neutral.0 */
              'bg-canvas':     '#fafafa',  /* neutral.50 */
              'bg-subtle':     '#f4f4f5',  /* neutral.100 */
              'bg-component':  '#ffffff',  /* neutral.0 */
              'bg-hover':      '#f4f4f5',  /* neutral.100 */
              /* fg tokens */
              'fg-base':       '#09090b',  /* neutral.950 */
              'fg-subtle':     '#52525b',  /* neutral.600 */
              'fg-muted':      '#71717a',  /* neutral.500 */
              'fg-disabled':   '#a1a1aa',  /* neutral.400 */
              /* border tokens */
              'border-base':   'rgba(0, 0, 0, 0.10)',
              'border-muted':  'rgba(0, 0, 0, 0.06)',
              /* accent */
              'accent':        '#2563eb',  /* blue.600 */
              'accent-muted':  '#eff6ff',  /* blue.50 */
              'accent-border': '#bfdbfe',  /* blue.200 */
              /* status */
              'success':       '#059669',  /* green.600 */
              'success-muted': '#ecfdf5',  /* green.50 */
              'success-border':'#a7f3d0',  /* green.200 */
              'error':         '#dc2626',  /* red.600 */
              'error-muted':   '#fef2f2',  /* red.50 */
              'error-border':  '#fecaca',  /* red.200 */
              'warning':       '#ea580c',  /* orange.600 */
              'warning-muted': '#fff7ed',  /* orange.50 */
              'warning-border':'#fed7aa',  /* orange.200 */
              /* chart / brand */
              'aave':          '#7976FF',
              'aave-muted':    '#f5f3ff',
            }
          },
          fontFamily: {
            sans: ['Inter', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
            mono: ['GeistMono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace']
          },
          fontSize: {
            'base': ['0.9rem', '1.5'],  /* 14.4px base like the hub */
            'sm':   ['0.8125rem', '1.375'],
            'xs':   ['0.75rem', '1.25'],
            '2xs':  ['0.625rem', '1.25'],
          },
          borderRadius: {
            'card': '0.25rem',  /* matches surface recipe rounded: 4 */
          },
          boxShadow: {
            'card': '0 0 0 1px rgba(0, 0, 0, 0.10), 0 1px 2px -1px rgba(0, 0, 0, 0.08), 0 2px 4px 0 rgba(0, 0, 0, 0.04)',
            'card-outlined': '0 0 0 1px rgba(0, 0, 0, 0.10)',
          }
        }
      }
    };
  </script>

  <style>
    html { font-size: 14.4px; }

    /* Custom Scrollbars */
    ::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }
    ::-webkit-scrollbar-track {
      background: #fafafa;
    }
    ::-webkit-scrollbar-thumb {
      background: #d4d4d8;
      border-radius: 4px;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: #a1a1aa;
    }

    /* Table row transition */
    tr {
      transition: background-color 0.15s ease;
    }

    /* Animation */
    @keyframes pulseDot {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.85); }
    }
    .pulse-dot {
      animation: pulseDot 2s infinite ease-in-out;
    }
  </style>
</head>

<body class="bg-tl-bg-canvas text-tl-fg-base min-h-screen font-sans selection:bg-blue-100 selection:text-blue-900 antialiased flex flex-col">

  <!-- ==================================================================== -->
  <!-- TOP NAVIGATION BAR                                                   -->
  <!-- ==================================================================== -->
  <header class="sticky top-0 z-30 bg-tl-bg-base border-b border-tl-border-base shadow-sm">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-12 flex items-center justify-between">
      
      <!-- Logos & Title -->
      <div class="flex items-center gap-2.5">
        <a href="https://tokenlogic.xyz" target="_blank" rel="noopener noreferrer" class="inline-flex items-center" title="TokenLogic">
          <img 
            src="./assets/tokenlogic-logo-dark.svg" 
            alt="TokenLogic" 
            class="h-[24px] w-auto"
          />
        </a>

        <!-- Diagonal separator matching hub's 120deg rotated line -->
        <div class="flex items-center justify-center w-2.5 h-[17px] relative">
          <svg width="20" height="2" viewBox="0 0 20 2" aria-hidden="true" class="text-neutral-300" style="transform: rotate(120deg); transform-origin: center;">
            <line x1="0" y1="1" x2="20" y2="1" stroke="currentColor" stroke-width="1" />
          </svg>
        </div>

        <a href="https://aave.com" target="_blank" rel="noopener noreferrer" class="inline-flex items-center" title="Aave">
          <img 
            src="./assets/aave-logo-dark.svg" 
            alt="Aave" 
            class="h-4 sm:h-[18px] w-auto"
          />
        </a>

        <!-- Vertical separator -->
        <svg width="1" height="16" viewBox="0 0 1 16" aria-hidden="true" class="text-neutral-200 hidden sm:block">
          <line x1="0.5" y1="0" x2="0.5" y2="16" stroke="currentColor" />
        </svg>

        <div class="hidden lg:flex flex-col">
          <span class="text-xs font-semibold uppercase tracking-wider text-tl-accent">BALANCES</span>
          <span class="text-2xs text-tl-fg-muted">Surplus & Stuck Token Dashboard</span>
        </div>
      </div>

      <!-- Right Header Links -->
      <div class="flex items-center gap-2.5 sm:gap-4 text-xs">
        <a 
          href="https://github.com/TokenLogic-com-au/aave-rescue-mission" 
          target="_blank" 
          rel="noopener noreferrer" 
          class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-tl-bg-subtle hover:bg-neutral-200 text-tl-fg-base border border-tl-border-base font-medium transition"
        >
          <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
            <path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
          </svg>
          <span>GitHub</span>
        </a>
      </div>

    </div>
  </header>

  <!-- ==================================================================== -->
  <!-- HERO BANNER                                                          -->
  <!-- ==================================================================== -->
  <section class="border-b border-tl-border-base bg-tl-bg-base py-8 sm:py-10 shadow-sm">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div>
          <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-tl-accent-muted border border-tl-accent-border text-tl-accent text-xs font-medium mb-3">
            <span class="w-1.5 h-1.5 rounded-full bg-tl-accent"></span>
            Aave V3 & V4 • On-Chain Balance Audit
          </div>
          <h1 class="text-2xl sm:text-3xl md:text-4xl font-extrabold tracking-tight text-tl-fg-base">
            Aave V3 & V4
            <span class="block text-transparent bg-clip-text bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 mt-1">
              Balances & Surplus Dashboard
            </span>
          </h1>
          <p id="hero-subtitle" class="mt-2 text-sm sm:text-base text-tl-fg-subtle max-w-3xl leading-relaxed">
            Multi-chain deterministic audit of rescueable underlying surplus, stuck tokens in pool & hub contracts, foreign aToken holdings, and self-held aTokens. All values verified against pinned blocks via Aave Oracle feeds.
          </p>
        </div>

        <div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
          <button 
            id="btn-export-csv"
            class="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded bg-tl-bg-base hover:bg-tl-bg-subtle text-tl-fg-base border border-tl-border-base font-medium text-sm transition shadow-sm"
          >
            <svg class="w-4 h-4 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Export CSV
          </button>

          <button 
            id="btn-export-json"
            class="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded bg-tl-bg-base hover:bg-tl-bg-subtle text-tl-fg-base border border-tl-border-base font-medium text-sm transition shadow-sm"
          >
            <svg class="w-4 h-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
            </svg>
            Export JSON
          </button>
        </div>
      </div>
    </div>
  </section>

  <!-- ==================================================================== -->
  <!-- MAIN CONTENT CONTAINER                                               -->
  <!-- ==================================================================== -->
  <main class="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 space-y-6">

    <!-- 4 TOP METRIC CARDS (DYNAMICALLY COMPUTED) -->
    <section class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      
      <!-- Card 1: Rescueable Surplus -->
      <div class="bg-tl-bg-base border border-tl-border-base rounded-card p-5 shadow-card relative overflow-hidden group hover:border-black/20 transition">
        <div class="absolute top-0 left-0 right-0 h-1 bg-emerald-500"></div>
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold uppercase tracking-wider text-tl-fg-muted">Rescueable Surplus</span>
          <div class="w-8 h-8 rounded bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-600">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
            </svg>
          </div>
        </div>
        <div class="mt-3">
          <div id="metric-surplus" class="text-2xl sm:text-3xl font-extrabold font-mono text-emerald-600 tracking-tight">
            $0.00
          </div>
          <p class="mt-1 text-xs text-tl-fg-muted flex items-center gap-1.5">
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
            <span>Positive recoverable asset value</span>
          </p>
        </div>
      </div>

      <!-- Card 2: Deficit -->
      <div class="bg-tl-bg-base border border-tl-border-base rounded-card p-5 shadow-card relative overflow-hidden group hover:border-black/20 transition">
        <div class="absolute top-0 left-0 right-0 h-1 bg-red-500"></div>
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold uppercase tracking-wider text-tl-fg-muted">System Deficit</span>
          <div class="w-8 h-8 rounded bg-red-50 border border-red-200 flex items-center justify-center text-red-600">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 12H4" />
            </svg>
          </div>
        </div>
        <div class="mt-3">
          <div id="metric-deficit" class="text-2xl sm:text-3xl font-extrabold font-mono text-red-600 tracking-tight">
            $0.00
          </div>
          <p class="mt-1 text-xs text-tl-fg-muted flex items-center gap-1.5">
            <span class="w-1.5 h-1.5 rounded-full bg-red-500"></span>
            <span>Underlying below virtual balance</span>
          </p>
        </div>
      </div>

      <!-- Card 3: Net Total -->
      <div class="bg-tl-bg-base border border-tl-border-base rounded-card p-5 shadow-card relative overflow-hidden group hover:border-black/20 transition">
        <div class="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-blue-600 to-indigo-600"></div>
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold uppercase tracking-wider text-tl-fg-muted">Net Total Value</span>
          <div class="w-8 h-8 rounded bg-blue-50 border border-blue-200 flex items-center justify-center text-blue-600">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
            </svg>
          </div>
        </div>
        <div class="mt-3">
          <div id="metric-net" class="text-2xl sm:text-3xl font-extrabold font-mono text-neutral-950 tracking-tight">
            $0.00
          </div>
          <p class="mt-1 text-xs text-tl-fg-muted flex items-center gap-1.5">
            <span class="w-1.5 h-1.5 rounded-full bg-blue-500"></span>
            <span>Surplus minus systemic deficit</span>
          </p>
        </div>
      </div>

      <!-- Card 4: Total Findings Count -->
      <div class="bg-tl-bg-base border border-tl-border-base rounded-card p-5 shadow-card relative overflow-hidden group hover:border-black/20 transition">
        <div class="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-purple-500 to-pink-500"></div>
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold uppercase tracking-wider text-tl-fg-muted">Active Findings</span>
          <div class="w-8 h-8 rounded bg-purple-50 border border-purple-200 flex items-center justify-center text-purple-600">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
            </svg>
          </div>
        </div>
        <div class="mt-3">
          <div id="metric-count" class="text-2xl sm:text-3xl font-extrabold font-mono text-tl-fg-base tracking-tight">
            0
          </div>
          <p id="metric-count-sub" class="mt-1 text-xs text-tl-fg-muted flex items-center gap-1.5">
            <span class="w-1.5 h-1.5 rounded-full bg-purple-500"></span>
            <span>Across all active filters</span>
          </p>
        </div>
      </div>

    </section>

    <!-- ================================================================== -->
    <!-- CONTROLS & TOOLBAR                                                 -->
    <!-- ================================================================== -->
    <section class="bg-tl-bg-base border border-tl-border-base rounded-card p-4 sm:p-5 space-y-4 shadow-card backdrop-blur">
      
      <!-- Network Selector Pills -->
      <div>
        <div class="flex items-center justify-between mb-2.5">
          <div class="flex items-center gap-2">
            <span class="text-xs font-semibold uppercase tracking-wider text-tl-fg-muted">Network Filter</span>
            <span id="active-network-indicator" class="text-[11px] text-tl-aave font-mono">All Networks</span>
          </div>
          <button id="btn-toggle-zero-chains" class="text-[11px] text-tl-fg-muted hover:text-tl-fg-base underline transition">
            Show 0-finding networks
          </button>
        </div>

        <div id="network-pills-container" class="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-thin">
          <!-- Network Pills Rendered Dynamically -->
        </div>
      </div>

      <!-- Protocol Version Filter -->
      <div class="pt-3 border-t border-tl-border-base">
        <div class="flex items-center justify-between mb-2">
          <div class="flex items-center gap-2">
            <span class="text-xs font-semibold uppercase tracking-wider text-tl-fg-muted">Protocol Version</span>
            <span id="active-protocol-indicator" class="text-[11px] text-tl-accent font-mono">All Versions</span>
          </div>
        </div>

        <div id="protocol-pills-container" class="flex items-center gap-2">
          <!-- Protocol Pills Rendered Dynamically -->
        </div>
      </div>

      <!-- Secondary Filters Toolbar -->
      <div class="pt-3 border-t border-tl-border-base flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-3 sm:gap-4">
        
        <!-- Live Search Input -->
        <div class="relative flex-1 min-w-[240px]">
          <div class="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-tl-fg-muted">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <input 
            type="text" 
            id="search-input" 
            placeholder="Search token (e.g. USDC), address (0x...), market, or note... [ / to focus ]" 
            class="w-full pl-10 pr-10 py-2 rounded-lg bg-tl-bg-canvas border border-tl-border-base text-tl-fg-base placeholder-tl-fg-muted text-sm focus:outline-none focus:border-tl-accent focus:ring-1 focus:ring-tl-accent transition"
          />
          <button 
            id="btn-clear-search" 
            class="hidden absolute inset-y-0 right-0 pr-3 flex items-center text-tl-fg-muted hover:text-tl-fg-base"
            title="Clear search"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <!-- Category Dropdown -->
        <div class="relative min-w-[220px]">
          <select 
            id="category-filter"
            class="w-full appearance-none px-3.5 py-2 pr-9 rounded-lg bg-tl-bg-canvas border border-tl-border-base text-tl-fg-base text-sm focus:outline-none focus:border-tl-accent focus:ring-1 focus:ring-tl-accent transition cursor-pointer"
          >
            <option value="all">All Finding Types</option>
            <option value="underlying-surplus">V3: Underlying Surplus & Deficit</option>
            <option value="token-in-pool">V3: Token in Pool (Stuck)</option>
            <option value="foreign-token-in-atoken">V3: Foreign Token in aToken</option>
            <option value="atoken-in-itself">V3: aToken in itself</option>
            <option value="v4-hub-surplus">V4: Hub Surplus</option>
            <option value="v4-hub-deficit">V4: Hub Deficit</option>
            <option value="v4-token-in-spoke">V4: Token in Spoke (Stuck)</option>
            <option value="v4-token-in-tokenization-spoke">V4: Token in TokenizationSpoke</option>
            <option value="v4-token-in-position-manager">V4: Token in PositionManager</option>
            <option value="v4-hub-clean">V4: Hub Verified Clean</option>
            <option value="v4-spoke-clean">V4: Spoke / PM Verified Clean</option>
          </select>
          <div class="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-tl-fg-muted">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </div>

        <!-- Dust Filter Toggle -->
        <label class="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-tl-bg-canvas border border-tl-border-base text-sm text-tl-fg-subtle select-none cursor-pointer hover:border-tl-border-base transition">
          <input 
            type="checkbox" 
            id="dust-filter" 
            checked
            class="w-4 h-4 rounded bg-tl-bg-subtle border-tl-border-base text-blue-600 focus:ring-tl-accent focus:ring-offset-tl-bg-canvas" 
          />
          <span>Hide Dust (&lt; $0.01)</span>
          <span id="dust-count-badge" class="ml-1 text-[11px] font-mono px-1.5 py-0.5 rounded bg-tl-bg-subtle text-tl-fg-muted">0</span>
        </label>

        <!-- Reset Button -->
        <button 
          id="btn-reset-filters" 
          class="hidden px-3 py-2 rounded-lg bg-tl-bg-subtle hover:bg-tl-bg-hover text-tl-fg-subtle text-xs font-medium border border-tl-border-muted transition flex items-center justify-center gap-1.5"
          title="Reset all filters"
        >
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Reset
        </button>

      </div>

    </section>

    <!-- ================================================================== -->
    <!-- DATA TABLE SECTION                                                 -->
    <!-- ================================================================== -->
    <section class="bg-tl-bg-base border border-tl-border-base rounded-card overflow-hidden shadow-card">
      
      <!-- Table Header Status Bar -->
      <div class="px-5 py-3.5 bg-tl-bg-canvas border-b border-tl-border-base flex flex-wrap items-center justify-between gap-3 text-xs text-tl-fg-muted">
        <div class="flex items-center gap-2">
          <span class="font-medium text-tl-fg-base" id="table-results-summary">Showing 0 findings</span>
          <span class="text-tl-fg-disabled">•</span>
          <span class="text-[11px]">Click any row to view full contract details and exact block pins</span>
        </div>

        <div class="flex items-center gap-2">
          <label for="page-size-select" class="text-tl-fg-muted">Rows per page:</label>
          <select 
            id="page-size-select" 
            class="bg-tl-bg-canvas border border-tl-border-base text-tl-fg-base text-xs rounded px-2 py-1 focus:outline-none focus:border-tl-accent"
          >
            <option value="25">25</option>
            <option value="50" selected>50</option>
            <option value="100">100</option>
            <option value="all">All</option>
          </select>
        </div>
      </div>

      <!-- Scrollable Table -->
      <div class="overflow-x-auto">
        <table class="w-full text-left text-xs sm:text-sm border-collapse">
          <thead class="bg-tl-bg-canvas text-tl-fg-muted uppercase tracking-wider text-[11px] font-semibold select-none border-b border-tl-border-base sticky top-0 z-10">
            <tr>
              <!-- Network & Market -->
              <th scope="col" class="py-3 px-4 cursor-pointer hover:text-tl-fg-base transition" data-sort="network">
                <div class="flex items-center gap-1.5">
                  <span>Network & Market</span>
                  <span class="sort-icon text-tl-fg-disabled text-[10px]" data-col="network">⇅</span>
                </div>
              </th>

              <!-- Type -->
              <th scope="col" class="py-3 px-4 cursor-pointer hover:text-tl-fg-base transition" data-sort="kind">
                <div class="flex items-center gap-1.5">
                  <span>Finding Type</span>
                  <span class="sort-icon text-tl-fg-disabled text-[10px]" data-col="kind">⇅</span>
                </div>
              </th>

              <!-- Holder -->
              <th scope="col" class="py-3 px-4">
                <span>Holder (Contract)</span>
              </th>

              <!-- Token -->
              <th scope="col" class="py-3 px-4 cursor-pointer hover:text-tl-fg-base transition" data-sort="token">
                <div class="flex items-center gap-1.5">
                  <span>Token</span>
                  <span class="sort-icon text-tl-fg-disabled text-[10px]" data-col="token">⇅</span>
                </div>
              </th>

              <!-- Amount Formatted -->
              <th scope="col" class="py-3 px-4 text-right cursor-pointer hover:text-tl-fg-base transition" data-sort="amount">
                <div class="flex items-center justify-end gap-1.5">
                  <span>Amount</span>
                  <span class="sort-icon text-tl-fg-disabled text-[10px]" data-col="amount">⇅</span>
                </div>
              </th>

              <!-- Virtual Balance -->
              <th scope="col" class="py-3 px-4 text-right">
                <span title="Virtual reserve balance tracked in Pool">Virtual Bal</span>
              </th>

              <!-- Oracle Price -->
              <th scope="col" class="py-3 px-4 text-right">
                <span>Price (USD)</span>
              </th>

              <!-- Value (USD) -->
              <th scope="col" class="py-3 px-4 text-right cursor-pointer hover:text-tl-fg-base transition" data-sort="value">
                <div class="flex items-center justify-end gap-1.5">
                  <span>Value (USD)</span>
                  <span class="sort-icon text-tl-aave text-[10px]" data-col="value">▼</span>
                </div>
              </th>

              <!-- Actions -->
              <th scope="col" class="py-3 px-4 text-center w-12">
                <span>Details</span>
              </th>
            </tr>
          </thead>
          <tbody id="findings-table-body" class="divide-y divide-tl-border-muted font-sans">
            <!-- Table rows dynamically populated -->
          </tbody>
        </table>
      </div>

      <!-- Empty State -->
      <div id="table-empty-state" class="hidden py-16 px-4 text-center">
        <div class="w-12 h-12 rounded-full bg-tl-bg-subtle text-tl-fg-muted flex items-center justify-center mx-auto mb-3">
          <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
        <h3 class="text-base font-semibold text-tl-fg-base">No findings match your criteria</h3>
        <p class="text-sm text-tl-fg-muted mt-1 max-w-sm mx-auto">
          Try clearing your search query, choosing "All Networks", or turning off the dust filter.
        </p>
        <button 
          id="btn-empty-reset" 
          class="mt-4 px-4 py-2 rounded-lg bg-tl-accent-muted hover:bg-blue-900 text-tl-accent border border-blue-800 text-xs font-semibold transition"
        >
          Reset All Filters
        </button>
      </div>

      <!-- Pagination Footer -->
      <div class="px-5 py-3.5 bg-tl-bg-canvas border-t border-tl-border-base flex flex-col sm:flex-row items-center justify-between gap-4 text-xs">
        <div id="pagination-info" class="text-tl-fg-muted font-mono text-[11px]">
          Showing 0 to 0 of 0 entries
        </div>

        <div id="pagination-controls" class="flex items-center gap-1.5">
          <!-- Dynamically populated page buttons -->
        </div>
      </div>

    </section>

  </main>

  <!-- ==================================================================== -->
  <!-- SLIDE-OVER DRAWER (DETAILS MODAL)                                     -->
  <!-- ==================================================================== -->
  <div 
    id="drawer-backdrop" 
    class="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 transition-opacity duration-300 opacity-0 pointer-events-none"
    aria-hidden="true"
  ></div>

  <aside 
    id="detail-drawer" 
    class="fixed top-0 right-0 bottom-0 w-full sm:w-[32rem] md:w-[36rem] max-w-full bg-tl-bg-base border-l border-tl-border-base shadow-2xl z-50 transform translate-x-full transition-transform duration-300 ease-in-out flex flex-col"
    role="dialog" 
    aria-modal="true" 
    aria-labelledby="drawer-title"
  >
    <!-- Drawer Header -->
    <div class="px-6 py-4 bg-tl-bg-canvas border-b border-tl-border-base flex items-center justify-between">
      <div class="flex items-center gap-2.5">
        <span id="drawer-network-badge" class="px-2.5 py-1 rounded-full text-xs font-semibold bg-purple-500/20 text-tl-accent border border-purple-500/30">
          Network
        </span>
        <h2 id="drawer-title" class="text-base font-bold text-white truncate max-w-[200px] sm:max-w-[260px]">
          Finding Details
        </h2>
      </div>

      <div class="flex items-center gap-2">
        <kbd class="hidden sm:inline-block px-1.5 py-0.5 text-[10px] font-mono text-tl-fg-muted bg-tl-bg-subtle border border-tl-border-base rounded">ESC</kbd>
        <button 
          id="btn-close-drawer" 
          class="w-8 h-8 rounded-lg bg-tl-bg-subtle hover:bg-tl-bg-hover text-tl-fg-subtle hover:text-white flex items-center justify-center transition"
          title="Close details (Esc)"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Drawer Body -->
    <div id="drawer-content" class="flex-1 overflow-y-auto p-6 space-y-6 text-sm">
      
      <!-- Value Hero Banner -->
      <div id="drawer-hero-box" class="p-5 rounded-card shadow-card border bg-tl-bg-canvas border-tl-border-base">
        <div class="flex items-center justify-between mb-2">
          <span id="drawer-kind-badge" class="px-2.5 py-0.5 rounded-full text-xs font-medium bg-tl-success-muted text-tl-success border border-tl-success-border">
            Underlying Surplus
          </span>
          <span id="drawer-market-tag" class="text-xs font-mono text-tl-fg-muted">Market</span>
        </div>

        <div class="mt-3 flex items-baseline justify-between flex-wrap gap-2">
          <div id="drawer-usd-value" class="text-3xl sm:text-4xl font-extrabold font-mono text-emerald-400 tracking-tight">
            +$0.00
          </div>
          <div class="text-right">
            <div id="drawer-token-amount" class="text-base font-bold text-tl-fg-base font-mono">0.00 TOKEN</div>
            <div id="drawer-token-price" class="text-xs text-tl-fg-muted">@ $0.00 / token</div>
          </div>
        </div>
      </div>

      <!-- Financial Breakdown Card -->
      <div class="bg-tl-bg-canvas border border-tl-border-base rounded-card shadow-card p-4 space-y-3">
        <h3 class="text-xs font-semibold uppercase tracking-wider text-tl-fg-muted flex items-center gap-1.5">
          <svg class="w-3.5 h-3.5 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Financial Breakdown
        </h3>

        <div class="space-y-2 text-xs">
          <!-- Unformatted Base Units (Prominent) -->
          <div class="p-2.5 rounded-lg bg-tl-bg-canvas border border-tl-border-base flex items-center justify-between gap-3">
            <div class="min-w-0">
              <span class="block text-[10px] uppercase tracking-wider text-tl-fg-disabled font-semibold">Exact Base Units (Raw Amount)</span>
              <span id="drawer-raw-amount" class="block font-mono text-xs text-tl-accent break-all select-all font-semibold">0</span>
            </div>
            <button 
              id="btn-copy-raw-amount" 
              class="shrink-0 p-1.5 rounded bg-tl-bg-subtle hover:bg-tl-bg-hover text-tl-fg-subtle hover:text-white transition"
              title="Copy exact raw base units"
            >
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>
          </div>

          <div class="p-2.5 rounded-lg bg-tl-bg-canvas border border-tl-border-base">
            <span class="block text-[10px] uppercase tracking-wider text-tl-fg-disabled">Oracle Base Unit</span>
            <span id="drawer-oracle-base" class="font-mono text-tl-fg-base font-semibold">100,000,000</span>
          </div>

          <div id="drawer-virtual-bal-box" class="p-2.5 rounded-lg bg-tl-bg-canvas border border-tl-border-base">
            <div class="flex items-center justify-between">
              <span class="text-[10px] uppercase tracking-wider text-tl-fg-disabled">Virtual Reserve Balance</span>
              <span id="drawer-virtual-bal-formatted" class="font-mono text-xs text-tl-fg-base font-semibold">0</span>
            </div>
            <div id="drawer-virtual-bal-raw" class="font-mono text-[10px] text-tl-fg-disabled break-all mt-0.5">Raw: 0</div>
          </div>
        </div>
      </div>

      <!-- Contract Details Card -->
      <div class="bg-tl-bg-canvas border border-tl-border-base rounded-card shadow-card p-4 space-y-3">
        <h3 class="text-xs font-semibold uppercase tracking-wider text-tl-fg-muted flex items-center gap-1.5">
          <svg class="w-3.5 h-3.5 text-tl-aave" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
          </svg>
          Contract Details & Verification
        </h3>

        <!-- Holder Address Box -->
        <div class="p-3 rounded-lg bg-tl-bg-canvas border border-tl-border-base space-y-1.5">
          <div class="flex items-center justify-between">
            <span class="text-[11px] font-medium text-tl-fg-subtle flex items-center gap-1.5">
              <span class="w-1.5 h-1.5 rounded-full bg-cyan-400"></span>
              <span>Holder Contract:</span>
              <span id="drawer-holder-symbol" class="font-mono font-bold text-cyan-300">aToken</span>
            </span>
            <div class="flex items-center gap-1">
              <button 
                id="btn-copy-holder-addr" 
                class="px-2 py-1 rounded bg-tl-bg-subtle hover:bg-tl-bg-hover text-tl-fg-subtle hover:text-white text-[11px] transition flex items-center gap-1"
                title="Copy holder address"
              >
                Copy
              </button>
              <a 
                id="link-holder-explorer" 
                href="#" 
                target="_blank" 
                rel="noopener noreferrer" 
                class="px-2 py-1 rounded bg-tl-bg-subtle hover:bg-tl-bg-hover text-cyan-400 hover:text-cyan-300 text-[11px] transition flex items-center gap-1"
                title="Open in block explorer"
              >
                Explorer ↗
              </a>
            </div>
          </div>
          <div id="drawer-holder-addr" class="font-mono text-xs text-tl-fg-muted break-all select-all">
            0x0000000000000000000000000000000000000000
          </div>
        </div>

        <!-- Token Address Box -->
        <div class="p-3 rounded-lg bg-tl-bg-canvas border border-tl-border-base space-y-1.5">
          <div class="flex items-center justify-between">
            <span class="text-[11px] font-medium text-tl-fg-subtle flex items-center gap-1.5">
              <span class="w-1.5 h-1.5 rounded-full bg-tl-aave"></span>
              <span>Token Contract:</span>
              <span id="drawer-token-symbol" class="font-mono font-bold text-tl-accent">TOKEN</span>
            </span>
            <div class="flex items-center gap-1">
              <button 
                id="btn-copy-token-addr" 
                class="px-2 py-1 rounded bg-tl-bg-subtle hover:bg-tl-bg-hover text-tl-fg-subtle hover:text-white text-[11px] transition flex items-center gap-1"
                title="Copy token address"
              >
                Copy
              </button>
              <a 
                id="link-token-explorer" 
                href="#" 
                target="_blank" 
                rel="noopener noreferrer" 
                class="px-2 py-1 rounded bg-tl-bg-subtle hover:bg-tl-bg-hover text-tl-aave hover:text-tl-accent text-[11px] transition flex items-center gap-1"
                title="Open in block explorer"
              >
                Explorer ↗
              </a>
            </div>
          </div>
          <div id="drawer-token-addr" class="font-mono text-xs text-tl-fg-muted break-all select-all">
            0x0000000000000000000000000000000000000000
          </div>
        </div>
      </div>

      <!-- Audit Trail & Block Pinning -->
      <div class="bg-tl-bg-canvas border border-tl-border-base rounded-card shadow-card p-4 space-y-3">
        <h3 class="text-xs font-semibold uppercase tracking-wider text-tl-fg-muted flex items-center gap-1.5">
          <svg class="w-3.5 h-3.5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
          </svg>
          Block Pinning & Deterministic Audit
        </h3>

        <div class="space-y-2 text-xs">
          <div class="flex items-center justify-between p-2 rounded bg-tl-bg-canvas border border-tl-border-base">
            <span class="text-tl-fg-muted">Pinned Block Height:</span>
            <a 
              id="link-pinned-block" 
              href="#" 
              target="_blank" 
              rel="noopener noreferrer" 
              class="font-mono text-cyan-400 hover:text-cyan-300 font-semibold underline flex items-center gap-1"
            >
              <span id="drawer-pinned-block">#00000000</span>
              <span class="text-[10px]">↗</span>
            </a>
          </div>

          <div class="flex items-center justify-between p-2 rounded bg-tl-bg-canvas border border-tl-border-base">
            <span class="text-tl-fg-muted">Timestamp:</span>
            <span id="drawer-pinned-at" class="font-mono text-tl-fg-base text-[11px]">-</span>
          </div>

          <div class="flex items-center justify-between p-2 rounded bg-tl-bg-canvas border border-tl-border-base">
            <span class="text-tl-fg-muted">Verification Status:</span>
            <span class="text-emerald-400 font-semibold flex items-center gap-1">
              <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
              Deterministic & Reproducible
            </span>
          </div>
        </div>
      </div>

      <!-- Notes & Classification Guidance -->
      <div class="bg-tl-bg-canvas border border-tl-border-base rounded-card shadow-card p-4 space-y-2.5">
        <h3 class="text-xs font-semibold uppercase tracking-wider text-tl-fg-muted">Classification & Rescue Guidance</h3>
        
        <p id="drawer-kind-explanation" class="text-xs text-tl-fg-subtle leading-relaxed">
          Guidance text...
        </p>

        <div id="drawer-note-container" class="hidden p-3 rounded-lg bg-tl-warning-muted border border-tl-warning-border text-tl-warning text-xs">
          <span class="font-semibold block mb-0.5">Audit Note:</span>
          <span id="drawer-note-text">-</span>
        </div>
      </div>

    </div>

    <!-- Drawer Footer Actions -->
    <div class="p-4 bg-tl-bg-canvas border-t border-tl-border-base flex items-center justify-between gap-3">
      <button 
        id="btn-copy-finding-json" 
        class="flex-1 py-2 px-3 rounded-lg bg-tl-bg-subtle hover:bg-tl-bg-hover text-tl-fg-base text-xs font-medium border border-tl-border-base transition flex items-center justify-center gap-1.5"
      >
        <svg class="w-3.5 h-3.5 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
        Copy Finding JSON
      </button>

      <button 
        id="btn-drawer-done" 
        class="py-2 px-5 rounded-lg bg-tl-accent-muted hover:bg-blue-900 text-tl-accent border border-blue-800 text-xs font-semibold transition"
      >
        Done
      </button>
    </div>
  </aside>

  <!-- ==================================================================== -->
  <!-- TOAST NOTIFICATION                                                   -->
  <!-- ==================================================================== -->
  <div 
    id="toast" 
    class="fixed bottom-6 right-6 z-50 transform translate-y-20 opacity-0 pointer-events-none transition-all duration-300 bg-tl-bg-canvas border border-tl-border-base text-tl-fg-base px-4 py-2.5 rounded-lg shadow-2xl flex items-center gap-2 text-xs sm:text-sm font-medium"
  >
    <svg class="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
    </svg>
    <span id="toast-message">Notification</span>
  </div>

  <!-- ==================================================================== -->
  <!-- FOOTER                                                               -->
  <!-- ==================================================================== -->
  <footer class="mt-auto border-t border-tl-border-base bg-tl-bg-base py-8 text-xs text-tl-fg-disabled">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col md:flex-row items-center justify-between gap-4">
      <div class="flex items-center gap-3">
        <a href="https://www.tokenlogic.xyz" target="_blank" rel="noopener noreferrer" class="text-tl-fg-muted hover:text-white transition font-medium">
          TokenLogic
        </a>
        <span>•</span>
        <a href="https://aave.com" target="_blank" rel="noopener noreferrer" class="text-tl-fg-muted hover:text-white transition font-medium">
          Aave DAO
        </a>
        <span>•</span>
        <span>Balances & Surplus Dashboard</span>
      </div>
    </div>
  </footer>

  <!-- ==================================================================== -->
  <!-- EMBEDDED DATA FALLBACK (Works seamlessly offline and via file://)     -->
  <!-- ==================================================================== -->
  <script id="initial-data" type="application/json">
${balancesCacheMin}
  </script>

  <!-- ==================================================================== -->
  <!-- APPLICATION JAVASCRIPT LOGIC                                         -->
  <!-- ==================================================================== -->
  <script>
    // ========================================================================
    // Explorer Mapping for all 21 Chains
    // ========================================================================
    const CHAINS_CONFIG = {
      1: { alias: 'mainnet', name: 'Ethereum', explorer: 'https://etherscan.io', badgeColor: 'border-blue-500/30 text-blue-300 bg-blue-500/15' },
      10: { alias: 'optimism', name: 'Optimism', explorer: 'https://optimistic.etherscan.io', badgeColor: 'border-red-500/30 text-red-300 bg-red-500/15' },
      56: { alias: 'bnb', name: 'BNB Chain', explorer: 'https://bscscan.com', badgeColor: 'border-amber-500/30 text-amber-300 bg-amber-500/15' },
      100: { alias: 'gnosis', name: 'Gnosis', explorer: 'https://gnosisscan.io', badgeColor: 'border-emerald-500/30 text-emerald-300 bg-emerald-500/15' },
      137: { alias: 'polygon', name: 'Polygon', explorer: 'https://polygonscan.com', badgeColor: 'border-purple-500/30 text-tl-accent bg-purple-500/15' },
      143: { alias: 'monad', name: 'Monad', explorer: 'https://monadscan.com', badgeColor: 'border-violet-500/30 text-violet-300 bg-violet-500/15' },
      146: { alias: 'sonic', name: 'Sonic', explorer: 'https://sonicscan.org', badgeColor: 'border-orange-500/30 text-orange-300 bg-orange-500/15' },
      196: { alias: 'xlayer', name: 'X Layer', explorer: 'https://www.oklink.com/xlayer', badgeColor: 'border-zinc-500/30 text-zinc-300 bg-zinc-500/15' },
      324: { alias: 'zksync', name: 'ZKsync Era', explorer: 'https://explorer.zksync.io', badgeColor: 'border-sky-500/30 text-sky-300 bg-sky-500/15' },
      1088: { alias: 'metis', name: 'Metis', explorer: 'https://explorer.metis.io', badgeColor: 'border-cyan-500/30 text-cyan-300 bg-cyan-500/15' },
      1868: { alias: 'soneium', name: 'Soneium', explorer: 'https://soneium.blockscout.com', badgeColor: 'border-indigo-500/30 text-indigo-300 bg-indigo-500/15' },
      4326: { alias: 'megaeth', name: 'MegaETH', explorer: 'https://mega.etherscan.io', badgeColor: 'border-rose-500/30 text-rose-300 bg-rose-500/15' },
      5000: { alias: 'mantle', name: 'Mantle', explorer: 'https://mantlescan.xyz', badgeColor: 'border-teal-500/30 text-teal-300 bg-teal-500/15' },
      8453: { alias: 'base', name: 'Base', explorer: 'https://basescan.org', badgeColor: 'border-blue-600/30 text-blue-300 bg-blue-600/15' },
      9745: { alias: 'plasma', name: 'Plasma', explorer: 'https://plasmascan.to', badgeColor: 'border-fuchsia-500/30 text-fuchsia-300 bg-fuchsia-500/15' },
      42161: { alias: 'arbitrum', name: 'Arbitrum', explorer: 'https://arbiscan.io', badgeColor: 'border-cyan-600/30 text-cyan-300 bg-cyan-600/15' },
      42220: { alias: 'celo', name: 'Celo', explorer: 'https://celoscan.io', badgeColor: 'border-lime-500/30 text-lime-300 bg-lime-500/15' },
      43114: { alias: 'avalanche', name: 'Avalanche', explorer: 'https://snowtrace.io', badgeColor: 'border-red-600/30 text-red-300 bg-red-600/15' },
      57073: { alias: 'ink', name: 'Ink', explorer: 'https://explorer.inkonchain.com', badgeColor: 'border-purple-600/30 text-tl-accent bg-purple-600/15' },
      59144: { alias: 'linea', name: 'Linea', explorer: 'https://lineascan.build', badgeColor: 'border-stone-500/30 text-stone-300 bg-stone-500/15' },
      534352: { alias: 'scroll', name: 'Scroll', explorer: 'https://scrollscan.com', badgeColor: 'border-amber-600/30 text-amber-300 bg-amber-600/15' }
    };

    function getChainMeta(chainKeyOrId) {
      if (typeof chainKeyOrId === 'number' || (!isNaN(Number(chainKeyOrId)) && chainKeyOrId !== '')) {
        const id = Number(chainKeyOrId);
        if (CHAINS_CONFIG[id]) return CHAINS_CONFIG[id];
      }
      const key = String(chainKeyOrId).toLowerCase();
      for (const c of Object.values(CHAINS_CONFIG)) {
        if (c.alias.toLowerCase() === key) return c;
      }
      return { alias: key, name: key, explorer: 'https://etherscan.io', badgeColor: 'border-tl-border-base text-tl-fg-subtle bg-tl-bg-subtle' };
    }

    function getExplorerAddressUrl(chainKeyOrId, address) {
      const meta = getChainMeta(chainKeyOrId);
      const base = meta.explorer.replace(/\\/$/, '');
      return base + '/address/' + address;
    }

    function getExplorerBlockUrl(chainKeyOrId, blockNumber) {
      const meta = getChainMeta(chainKeyOrId);
      const base = meta.explorer.replace(/\\/$/, '');
      return base + '/block/' + blockNumber;
    }

    // ========================================================================
    // Number & Currency Formatting Helpers
    // ========================================================================
    function parseUsdCents(usdStr) {
      if (!usdStr) return 0n;
      const isNeg = usdStr.startsWith('-');
      const [whole, frac = ''] = usdStr.replace('-', '').split('.');
      const cents = BigInt(whole || '0') * 100n + BigInt(frac.padEnd(2, '0').slice(0, 2));
      return isNeg ? -cents : cents;
    }

    function formatUsdCents(cents) {
      const isNeg = cents < 0n;
      const abs = isNeg ? -cents : cents;
      const num = Number(abs) / 100;
      return (isNeg ? '-' : '') + '$' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function formatDisplayAmount(amountFormattedStr) {
      if (!amountFormattedStr) return '0';
      const num = parseFloat(amountFormattedStr);
      if (isNaN(num)) return amountFormattedStr;
      const isNeg = amountFormattedStr.startsWith('-');
      const absStr = isNeg ? amountFormattedStr.slice(1) : amountFormattedStr;
      const parts = absStr.split('.');
      const intVal = BigInt(parts[0] || '0');
      const intFormatted = (isNeg ? '-' : '') + intVal.toLocaleString('en-US');
      
      if (Math.abs(num) >= 1000) {
        const frac = parts[1] ? '.' + parts[1].slice(0, 2) : '';
        return intFormatted + frac;
      }
      if (Math.abs(num) >= 1) {
        const frac = parts[1] ? '.' + parts[1].slice(0, 4) : '';
        return intFormatted + frac;
      }
      if (num === 0) return '0';
      if (parts[1]) {
        const trimmed = parts[1].slice(0, 8).replace(/0+$/, '');
        return (isNeg ? '-' : '') + (parts[0] || '0') + '.' + (trimmed || '0');
      }
      return amountFormattedStr;
    }

    function formatUnitsFromRaw(baseUnitsStr, decimals) {
      if (!baseUnitsStr) return '0';
      const isNeg = baseUnitsStr.startsWith('-');
      const raw = isNeg ? baseUnitsStr.slice(1) : baseUnitsStr;
      const dec = Number(decimals) || 18;
      const padded = raw.padStart(dec + 1, '0');
      const intPart = padded.slice(0, padded.length - dec) || '0';
      let fracPart = padded.slice(padded.length - dec);
      fracPart = fracPart.replace(/0+$/, '');
      const formattedInt = BigInt(intPart).toLocaleString('en-US');
      if (!fracPart) return (isNeg ? '-' : '') + formattedInt;
      const displayFrac = fracPart.length > 4 ? fracPart.slice(0, 4) : fracPart;
      return (isNeg ? '-' : '') + formattedInt + '.' + displayFrac;
    }

    function truncateAddress(addr) {
      if (!addr || addr.length < 10) return addr || '';
      return addr.slice(0, 6) + '...' + addr.slice(-4);
    }

    // ========================================================================
    // State Management
    // ========================================================================
    let rawCacheData = null;
    let allFindings = [];
    let filteredFindings = [];
    let activeFindingForDrawer = null;

    let filters = {
      network: 'all',
      protocol: 'all', // 'all', 'v3', 'v4'
      category: 'all',
      search: '',
      hideDust: true,
    };

    function getProtocolVersion(f) {
      if ((f.market && f.market.includes('V4')) || (f.chainAlias && f.chainAlias.endsWith('-v4')) || (f.kind && f.kind.startsWith('v4-'))) {
        return 'v4';
      }
      return 'v3';
    }

    function isDust(f) {
      if (f.amount === '0' || (f.kind && f.kind.endsWith('-clean'))) {
        return false;
      }
      const val = Math.abs(parseFloat(f.valueUsd || '0'));
      return val < 0.01;
    }

    function getSupportedNetworks(protocol) {
      if (protocol === 'all') return null;
      const supported = new Set();
      if (rawCacheData && rawCacheData.chains) {
        for (const [alias, chain] of Object.entries(rawCacheData.chains)) {
          const isV4 = alias.endsWith('-v4') || (chain.market && chain.market.includes('V4'));
          const netAlias = alias.replace('-v4', '');
          if (protocol === 'v4' && isV4) {
            supported.add(netAlias);
          } else if (protocol === 'v3' && !isV4) {
            supported.add(netAlias);
          }
        }
      }
      for (const f of allFindings) {
        if (getProtocolVersion(f) === protocol) {
          supported.add(f.chainAlias);
        }
      }
      return supported;
    }

    let sortState = {
      column: 'value',
      order: 'desc', // 'asc' or 'desc'
    };

    let paginationState = {
      currentPage: 1,
      pageSize: 50,
    };

    let showZeroChains = false;

    // Toast feedback
    let toastTimeout = null;
    function showToast(message) {
      const toast = document.getElementById('toast');
      const toastMsg = document.getElementById('toast-message');
      toastMsg.textContent = message;
      toast.classList.remove('translate-y-20', 'opacity-0', 'pointer-events-none');
      if (toastTimeout) clearTimeout(toastTimeout);
      toastTimeout = setTimeout(() => {
        toast.classList.add('translate-y-20', 'opacity-0', 'pointer-events-none');
      }, 2500);
    }

    function copyToClipboard(text, successMsg = 'Copied to clipboard', triggerEl = null) {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(() => {
          showToast(successMsg);
          flashCopyIcon(triggerEl);
        }).catch(() => fallbackCopy(text, successMsg, triggerEl));
      } else {
        fallbackCopy(text, successMsg, triggerEl);
      }
    }

    function fallbackCopy(text, successMsg, triggerEl) {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.left = '-999999px';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      try {
        document.execCommand('copy');
        showToast(successMsg);
        flashCopyIcon(triggerEl);
      } catch (err) {
        console.error('Fallback copy failed', err);
      }
      document.body.removeChild(textArea);
    }

    function flashCopyIcon(triggerEl) {
      if (!triggerEl) return;
      const original = triggerEl.innerHTML;
      triggerEl.innerHTML = \`<svg class="w-3.5 h-3.5 text-emerald-400 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>\`;
      setTimeout(() => { triggerEl.innerHTML = original; }, 1400);
    }

    // ========================================================================
    // Data Ingestion & Fallback
    // ========================================================================
    async function initData() {
      try {
        // Attempt network fetch first (cache-busting query)
        const res = await fetch('./data/balances-cache.json?t=' + Date.now());
        if (res.ok) {
          rawCacheData = await res.json();
        } else {
          throw new Error('HTTP ' + res.status);
        }
      } catch (e) {
        console.warn('Network fetch failed or running on file:// protocol. Falling back to embedded initial-data.', e);
        const embedded = document.getElementById('initial-data');
        if (embedded && embedded.textContent.trim()) {
          rawCacheData = JSON.parse(embedded.textContent);
        }
      }

      if (!rawCacheData || !rawCacheData.chains) {
        console.error('Failed to load scan cache data.');
        return;
      }

      // Extract all findings with chain context
      allFindings = [];
      const chainAliases = Object.keys(rawCacheData.chains);
      let totalPinnedBlocks = 0;

      for (const [alias, chain] of Object.entries(rawCacheData.chains)) {
        if (chain.pinnedBlock) totalPinnedBlocks++;
        if (Array.isArray(chain.findings)) {
          for (const f of chain.findings) {
            allFindings.push({
              ...f,
              chainAlias: f.chainAlias || alias,
              chainId: f.chainId || chain.chainId,
              pinnedBlock: chain.pinnedBlock,
              pinnedAt: chain.pinnedAt,
              oracleBaseUnit: chain.oracleBaseUnit || '100000000',
            });
          }
        }
      }

      document.getElementById('hero-subtitle').textContent = 
        \`Multi-chain deterministic audit of rescueable underlying surplus, stuck tokens in pool contracts, foreign aToken holdings, and self-held aTokens. Verified across \${chainAliases.length} networks with \${totalPinnedBlocks} pinned block heights.\`;

      renderNetworkPills();
      renderProtocolPills();
      updateDustBadge();
      applyFilters();
    }

    // ========================================================================
    // Network Pills Rendering
    // ========================================================================
    function renderNetworkPills() {
      const container = document.getElementById('network-pills-container');
      container.innerHTML = '';

      const supportedNetworks = getSupportedNetworks(filters.protocol);

      // Count findings per network matching protocol & dust filters
      const networkCounts = {};
      let totalMatchingFindings = 0;

      for (const f of allFindings) {
        // Protocol filter
        if (filters.protocol !== 'all' && getProtocolVersion(f) !== filters.protocol) {
          continue;
        }
        // Dust filter
        if (filters.hideDust && isDust(f)) {
          continue;
        }

        networkCounts[f.chainAlias] = (networkCounts[f.chainAlias] || 0) + 1;
        totalMatchingFindings++;
      }

      // Collect unique network definitions from rawCacheData.chains
      const networkMap = new Map();
      for (const [alias, chain] of Object.entries(rawCacheData.chains)) {
        const netAlias = alias.replace('-v4', '');
        if (!networkMap.has(netAlias)) {
          networkMap.set(netAlias, {
            alias: netAlias,
            chainId: chain.chainId,
            name: getChainMeta(chain.chainId).name
          });
        }
      }

      // Filter networks by protocol support
      let networkList = Array.from(networkMap.values());
      if (supportedNetworks !== null) {
        networkList = networkList.filter(n => supportedNetworks.has(n.alias));
      }

      // Attach counts and sort
      const sortedChains = networkList.map(n => ({
        ...n,
        count: networkCounts[n.alias] || 0
      })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

      // "All Networks" Pill
      const allPill = document.createElement('button');
      const isAllActive = filters.network === 'all';
      allPill.className = \`px-3 py-1.5 rounded-full text-xs font-medium transition shrink-0 flex items-center gap-1.5 border \${
        isAllActive 
          ? 'bg-neutral-900 text-white border-neutral-900 shadow-sm' 
          : 'bg-neutral-100 hover:bg-neutral-200 text-neutral-700 border-neutral-200/80'
      }\`;
      allPill.innerHTML = \`<span>All Networks</span> <span class="px-1.5 py-0.2 rounded-full text-[10px] font-bold \${isAllActive ? 'bg-neutral-700 text-neutral-100' : 'bg-neutral-200 text-neutral-700'}">\${totalMatchingFindings}</span>\`;
      allPill.onclick = () => {
        filters.network = 'all';
        renderNetworkPills();
        renderProtocolPills();
        applyFilters();
      };
      container.appendChild(allPill);

      // Per-network pills
      for (const c of sortedChains) {
        // If protocol is 'all' or 'v3', hide zero-count chains unless showZeroChains is true or it's currently selected.
        // For 'v4', always show supported networks so user can see which networks exist for this protocol.
        if (filters.protocol !== 'v4' && !showZeroChains && c.count === 0 && filters.network !== c.alias) {
          continue;
        }

        const pill = document.createElement('button');
        const isActive = filters.network === c.alias;
        pill.className = \`px-3 py-1.5 rounded-full text-xs font-medium transition shrink-0 flex items-center gap-1.5 border \${
          isActive 
            ? 'bg-neutral-900 text-white border-neutral-900 shadow-sm' 
            : 'bg-neutral-100 hover:bg-neutral-200 text-neutral-700 border-neutral-200/80'
        }\`;
        
        pill.innerHTML = \`
          <span>\${c.name}</span>
          <span class="px-1.5 py-0.2 rounded-full text-[10px] font-bold \${isActive ? 'bg-neutral-700 text-neutral-100' : (c.count > 0 ? 'bg-blue-100 text-blue-700' : 'bg-neutral-200 text-neutral-500')}">
            \${c.count}
          </span>
        \`;

        pill.onclick = () => {
          filters.network = c.alias;
          renderNetworkPills();
          renderProtocolPills();
          applyFilters();
        };

        container.appendChild(pill);
      }

      const activeLabel = filters.network === 'all' ? 'All Networks' : (getChainMeta(filters.network).name || filters.network);
      document.getElementById('active-network-indicator').textContent = activeLabel;
    }

    // ========================================================================
    // Protocol Pills Rendering (V3 vs V4)
    // ========================================================================
    function renderProtocolPills() {
      const container = document.getElementById('protocol-pills-container');
      if (!container) return;
      container.innerHTML = '';

      let v3Count = 0;
      let v4Count = 0;
      let totalCount = 0;

      for (const f of allFindings) {
        // Network filter
        if (filters.network !== 'all' && f.chainAlias !== filters.network) {
          continue;
        }
        // Dust filter
        if (filters.hideDust && isDust(f)) {
          continue;
        }

        totalCount++;
        if (getProtocolVersion(f) === 'v4') {
          v4Count++;
        } else {
          v3Count++;
        }
      }

      const protocols = [
        { id: 'all', name: 'All Protocols', count: totalCount },
        { id: 'v3', name: 'Aave V3', count: v3Count },
        { id: 'v4', name: 'Aave V4', count: v4Count },
      ];

      for (const p of protocols) {
        const pill = document.createElement('button');
        const isActive = filters.protocol === p.id;
        pill.className = \`px-3 py-1.5 rounded-full text-xs font-medium transition shrink-0 flex items-center gap-1.5 border \${
          isActive 
            ? 'bg-neutral-900 text-white border-neutral-900 shadow-sm' 
            : 'bg-neutral-100 hover:bg-neutral-200 text-neutral-700 border-neutral-200/80'
        }\`;
        
        pill.innerHTML = \`
          <span>\${p.name}</span>
          <span class="px-1.5 py-0.2 rounded-full text-[10px] font-bold \${isActive ? 'bg-neutral-700 text-neutral-100' : (p.count > 0 ? 'bg-blue-100 text-blue-700' : 'bg-neutral-200 text-neutral-500')}">
            \${p.count}
          </span>
        \`;

        pill.onclick = () => {
          filters.protocol = p.id;
          const supported = getSupportedNetworks(p.id);
          if (supported && filters.network !== 'all' && !supported.has(filters.network)) {
            filters.network = 'all';
          }
          renderNetworkPills();
          renderProtocolPills();
          applyFilters();
        };

        container.appendChild(pill);
      }

      const activeLabel = filters.protocol === 'all' ? 'All Versions' : (filters.protocol === 'v4' ? 'Aave V4' : 'Aave V3');
      document.getElementById('active-protocol-indicator').textContent = activeLabel;
    }

    function updateDustBadge() {
      let dustCount = 0;
      for (const f of allFindings) {
        if (filters.network !== 'all' && f.chainAlias !== filters.network) continue;
        if (filters.protocol !== 'all' && getProtocolVersion(f) !== filters.protocol) continue;
        if (isDust(f)) dustCount++;
      }
      document.getElementById('dust-count-badge').textContent = dustCount;
    }

    // ========================================================================
    // Filter & Sort Pipeline
    // ========================================================================
    function applyFilters() {
      const q = filters.search.trim().toLowerCase();

      filteredFindings = allFindings.filter(f => {
        // Network filter
        if (filters.network !== 'all' && f.chainAlias !== filters.network) {
          return false;
        }

        // Protocol version filter (v3 vs v4)
        if (filters.protocol !== 'all' && getProtocolVersion(f) !== filters.protocol) {
          return false;
        }

        // Category filter
        if (filters.category !== 'all' && f.kind !== filters.category) {
          return false;
        }

        // Dust filter
        if (filters.hideDust && isDust(f)) {
          return false;
        }

        // Search query filter
        if (q) {
          const matchToken = (f.tokenSymbol || '').toLowerCase().includes(q);
          const matchTokenAddr = (f.token || '').toLowerCase().includes(q);
          const matchHolder = (f.holderSymbol || '').toLowerCase().includes(q);
          const matchHolderAddr = (f.holder || '').toLowerCase().includes(q);
          const matchMarket = (f.market || '').toLowerCase().includes(q);
          const matchChain = (f.chainAlias || '').toLowerCase().includes(q);
          const matchNote = (f.note || '').toLowerCase().includes(q);
          if (!matchToken && !matchTokenAddr && !matchHolder && !matchHolderAddr && !matchMarket && !matchChain && !matchNote) {
            return false;
          }
        }

        return true;
      });

      // Show/hide reset button
      const hasActiveFilters = filters.network !== 'all' || filters.protocol !== 'all' || filters.category !== 'all' || filters.search !== '' || !filters.hideDust;
      document.getElementById('btn-reset-filters').classList.toggle('hidden', !hasActiveFilters);

      applySorting();
      updateDustBadge();
      updateMetricCards();
      paginationState.currentPage = 1;
      renderTable();
    }

    function applySorting() {
      const { column, order } = sortState;
      const mult = order === 'asc' ? 1 : -1;

      filteredFindings.sort((a, b) => {
        if (column === 'value') {
          const valA = parseFloat(a.valueUsd || '0');
          const valB = parseFloat(b.valueUsd || '0');
          return (valA - valB) * mult;
        }
        if (column === 'amount') {
          // Compare base units if same decimals, else formatted float
          const valA = parseFloat(a.amountFormatted || '0');
          const valB = parseFloat(b.amountFormatted || '0');
          return (valA - valB) * mult;
        }
        if (column === 'network') {
          return (a.chainAlias || '').localeCompare(b.chainAlias || '') * mult;
        }
        if (column === 'token') {
          return (a.tokenSymbol || '').localeCompare(b.tokenSymbol || '') * mult;
        }
        if (column === 'kind') {
          return (a.kind || '').localeCompare(b.kind || '') * mult;
        }
        return 0;
      });
    }

    // ========================================================================
    // Top Metric Cards Update
    // ========================================================================
    function updateMetricCards() {
      let posCents = 0n;
      let negCents = 0n;
      const count = filteredFindings.length;

      for (const f of filteredFindings) {
        const c = parseUsdCents(f.valueUsd);
        if (c > 0n) posCents += c;
        else if (c < 0n) negCents += -c;
      }

      const netCents = posCents - negCents;

      document.getElementById('metric-surplus').textContent = formatUsdCents(posCents);
      document.getElementById('metric-deficit').textContent = negCents > 0n ? ('-' + formatUsdCents(negCents)) : '$0.00';
      document.getElementById('metric-net').textContent = (netCents < 0n ? '-' : '') + formatUsdCents(netCents < 0n ? -netCents : netCents);
      document.getElementById('metric-count').textContent = count.toLocaleString('en-US');
      
      const networkCount = new Set(filteredFindings.map(f => f.chainAlias)).size;
      document.getElementById('metric-count-sub').innerHTML = 
        \`<span class="w-1.5 h-1.5 rounded-full bg-tl-aave"></span><span>Across \${networkCount} active network\${networkCount === 1 ? '' : 's'}</span>\`;
    }

    // ========================================================================
    // Table Rendering & Pagination
    // ========================================================================
    function renderTable() {
      const tbody = document.getElementById('findings-table-body');
      const emptyState = document.getElementById('table-empty-state');
      const total = filteredFindings.length;

      if (total === 0) {
        tbody.innerHTML = '';
        emptyState.classList.remove('hidden');
        document.getElementById('table-results-summary').textContent = 'No findings';
        document.getElementById('pagination-info').textContent = '0 of 0 entries';
        document.getElementById('pagination-controls').innerHTML = '';
        return;
      }

      emptyState.classList.add('hidden');

      // Pagination slice
      let pageSize = paginationState.pageSize === 'all' ? total : parseInt(paginationState.pageSize, 10);
      const totalPages = Math.ceil(total / pageSize) || 1;
      if (paginationState.currentPage > totalPages) paginationState.currentPage = totalPages;

      const startIndex = (paginationState.currentPage - 1) * pageSize;
      const endIndex = Math.min(startIndex + pageSize, total);
      const pageRows = filteredFindings.slice(startIndex, endIndex);

      document.getElementById('table-results-summary').textContent = 
        \`Showing \${startIndex + 1}–\${endIndex} of \${total} findings\`;
      document.getElementById('pagination-info').textContent = 
        \`Showing \${startIndex + 1} to \${endIndex} of \${total} entries\`;

      // Render Rows
      let html = '';
      for (let i = 0; i < pageRows.length; i++) {
        const f = pageRows[i];
        const globalIdx = startIndex + i;
        const chainMeta = getChainMeta(f.chainId || f.chainAlias);
        
        // Value styling
        const valNum = parseFloat(f.valueUsd || '0');
        let valColorClass = 'text-neutral-400';
        let valPrefix = '';
        if (valNum > 0) {
          valColorClass = 'text-emerald-600 font-semibold';
          valPrefix = '+';
        } else if (valNum < 0) {
          valColorClass = 'text-red-600 font-semibold';
        }

        // Kind Badge
        let kindBadge = '';
        if (f.kind === 'underlying-surplus') {
          if (valNum < 0 || (f.amount && f.amount.startsWith('-'))) {
            kindBadge = '<span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-red-50 text-red-700 border border-red-200">Deficit</span>';
          } else {
            kindBadge = '<span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">Surplus</span>';
          }
        } else if (f.kind === 'token-in-pool') {
          kindBadge = '<span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-amber-50 text-amber-800 border border-amber-200">Token in Pool</span>';
        } else if (f.kind === 'foreign-token-in-atoken') {
          kindBadge = '<span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-blue-50 text-blue-700 border border-blue-200">Foreign in aToken</span>';
        } else if (f.kind === 'atoken-in-itself') {
          kindBadge = '<span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-purple-50 text-purple-700 border border-purple-200">aToken in itself</span>';
        } else if (f.kind === 'v4-hub-surplus') {
          kindBadge = '<span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">V4 Hub Surplus</span>';
        } else if (f.kind === 'v4-hub-deficit') {
          kindBadge = '<span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-red-50 text-red-700 border border-red-200">V4 Hub Deficit</span>';
        } else if (f.kind === 'v4-token-in-spoke') {
          kindBadge = '<span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-amber-50 text-amber-800 border border-amber-200">V4 Stuck in Spoke</span>';
        } else if (f.kind === 'v4-token-in-tokenization-spoke') {
          kindBadge = '<span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-amber-50 text-amber-800 border border-amber-200">V4 Stuck in TSpoke</span>';
        } else if (f.kind === 'v4-token-in-position-manager') {
          kindBadge = '<span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-amber-50 text-amber-800 border border-amber-200">V4 Stuck in PM</span>';
        } else if (f.kind === 'v4-hub-clean') {
          kindBadge = '<span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">✓ V4 Hub Clean</span>';
        } else if (f.kind === 'v4-spoke-clean') {
          kindBadge = '<span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-blue-50 text-blue-700 border border-blue-200">✓ V4 Spoke Clean</span>';
        }

        // Virtual balance display
        let virtBalDisplay = '<span class="text-tl-fg-disabled">—</span>';
        if (f.virtualBalance) {
          virtBalDisplay = \`<span class="font-mono text-tl-fg-subtle" title="Raw: \${f.virtualBalance}">\${formatUnitsFromRaw(f.virtualBalance, f.decimals)}</span>\`;
        }

        // Oracle Price display
        const priceDisplay = f.priceUsd ? ('$' + parseFloat(f.priceUsd).toLocaleString('en-US', { maximumFractionDigits: 4 })) : '<span class="text-tl-fg-disabled">—</span>';

        // Explorer links
        const holderExplorer = getExplorerAddressUrl(f.chainId, f.holder);
        const tokenExplorer = getExplorerAddressUrl(f.chainId, f.token);

        html += \`
          <tr 
            class="hover:bg-neutral-50/90 cursor-pointer group transition"
            onclick="openDrawerByIndex(\${globalIdx})"
          >
            <!-- Network & Market -->
            <td class="py-3 px-4">
              <div class="flex flex-col">
                <span class="inline-flex items-center gap-1.5 font-medium text-tl-fg-base">
                  <span class="w-2 h-2 rounded-full \${chainMeta.badgeColor}"></span>
                  <span>\${chainMeta.name}</span>
                </span>
                <span class="text-[11px] text-tl-fg-muted font-mono mt-0.5 truncate max-w-[140px]" title="\${f.market}">
                  \${f.market}
                </span>
              </div>
            </td>

            <!-- Kind Badge -->
            <td class="py-3 px-4">
              \${kindBadge}
            </td>

            <!-- Holder -->
            <td class="py-3 px-4" onclick="event.stopPropagation()">
              <div class="flex flex-col">
                <span class="font-mono font-semibold text-tl-fg-base text-xs">\${f.holderSymbol || 'Holder'}</span>
                <div class="flex items-center gap-1.5 mt-0.5 text-[11px] text-tl-fg-muted">
                  <span class="font-mono truncate max-w-[90px]" title="\${f.holder}">\${truncateAddress(f.holder)}</span>
                  <button 
                    onclick="copyToClipboard('\${f.holder}', 'Copied holder address', this)" 
                    class="p-0.5 text-tl-fg-disabled hover:text-tl-fg-subtle transition" 
                    title="Copy address"
                  >
                    <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                  </button>
                  <a 
                    href="\${holderExplorer}" 
                    target="_blank" 
                    rel="noopener noreferrer" 
                    class="text-tl-fg-disabled hover:text-cyan-400 transition" 
                    title="View holder in explorer"
                  >
                    ↗
                  </a>
                </div>
              </div>
            </td>

            <!-- Token -->
            <td class="py-3 px-4" onclick="event.stopPropagation()">
              <div class="flex flex-col">
                <span class="font-mono font-bold text-tl-accent text-xs">\${f.tokenSymbol || 'TOKEN'}</span>
                <div class="flex items-center gap-1.5 mt-0.5 text-[11px] text-tl-fg-muted">
                  <span class="font-mono truncate max-w-[90px]" title="\${f.token}">\${truncateAddress(f.token)}</span>
                  <button 
                    onclick="copyToClipboard('\${f.token}', 'Copied token address', this)" 
                    class="p-0.5 text-tl-fg-disabled hover:text-tl-fg-subtle transition" 
                    title="Copy token address"
                  >
                    <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                  </button>
                  <a 
                    href="\${tokenExplorer}" 
                    target="_blank" 
                    rel="noopener noreferrer" 
                    class="text-tl-fg-disabled hover:text-tl-aave transition" 
                    title="View token in explorer"
                  >
                    ↗
                  </a>
                </div>
              </div>
            </td>

            <!-- Amount Formatted -->
            <td class="py-3 px-4 text-right">
              <div class="font-mono text-tl-fg-base font-semibold" title="\${f.amountFormatted}">
                \${formatDisplayAmount(f.amountFormatted)}
              </div>
            </td>

            <!-- Virtual Balance -->
            <td class="py-3 px-4 text-right">
              \${virtBalDisplay}
            </td>

            <!-- Oracle Price -->
            <td class="py-3 px-4 text-right font-mono text-tl-fg-subtle text-xs">
              \${priceDisplay}
            </td>

            <!-- Value (USD) -->
            <td class="py-3 px-4 text-right">
              <div class="font-mono text-sm \${valColorClass}">
                \${valPrefix}$\${Math.abs(valNum).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </td>

            <!-- Action -->
            <td class="py-3 px-4 text-center">
              <span class="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-tl-bg-subtle group-hover:bg-blue-600 text-tl-fg-muted group-hover:text-white transition">
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                </svg>
              </span>
            </td>
          </tr>
        \`;
      }

      tbody.innerHTML = html;
      renderPaginationControls(totalPages);
    }

    function renderPaginationControls(totalPages) {
      const container = document.getElementById('pagination-controls');
      container.innerHTML = '';

      if (totalPages <= 1) return;

      const current = paginationState.currentPage;

      // Prev button
      const prevBtn = document.createElement('button');
      prevBtn.className = \`px-2.5 py-1 rounded bg-tl-bg-canvas border border-tl-border-base text-tl-fg-subtle hover:bg-tl-bg-subtle disabled:opacity-40 disabled:pointer-events-none transition\`;
      prevBtn.innerHTML = '← Prev';
      prevBtn.disabled = current === 1;
      prevBtn.onclick = () => {
        if (paginationState.currentPage > 1) {
          paginationState.currentPage--;
          renderTable();
        }
      };
      container.appendChild(prevBtn);

      // Page numbers (smart window)
      const pagesToShow = [];
      pagesToShow.push(1);
      for (let p = Math.max(2, current - 1); p <= Math.min(totalPages - 1, current + 1); p++) {
        pagesToShow.push(p);
      }
      if (totalPages > 1 && !pagesToShow.includes(totalPages)) {
        pagesToShow.push(totalPages);
      }

      let last = 0;
      for (const p of pagesToShow) {
        if (last && p - last > 1) {
          const ellipsis = document.createElement('span');
          ellipsis.className = 'px-1 text-tl-fg-disabled';
          ellipsis.textContent = '...';
          container.appendChild(ellipsis);
        }

        const pageBtn = document.createElement('button');
        const isCurrent = p === current;
        pageBtn.className = \`px-2.5 py-1 rounded font-mono text-xs transition \${
          isCurrent 
            ? 'bg-tl-accent-muted text-tl-accent border border-blue-800 font-bold' 
            : 'bg-tl-bg-canvas border border-tl-border-base text-tl-fg-subtle hover:bg-tl-bg-subtle'
        }\`;
        pageBtn.textContent = p;
        pageBtn.onclick = () => {
          paginationState.currentPage = p;
          renderTable();
        };
        container.appendChild(pageBtn);

        last = p;
      }

      // Next button
      const nextBtn = document.createElement('button');
      nextBtn.className = \`px-2.5 py-1 rounded bg-tl-bg-canvas border border-tl-border-base text-tl-fg-subtle hover:bg-tl-bg-subtle disabled:opacity-40 disabled:pointer-events-none transition\`;
      nextBtn.innerHTML = 'Next →';
      nextBtn.disabled = current === totalPages;
      nextBtn.onclick = () => {
        if (paginationState.currentPage < totalPages) {
          paginationState.currentPage++;
          renderTable();
        }
      };
      container.appendChild(nextBtn);
    }

    // ========================================================================
    // Slide-over Drawer / Modal
    // ========================================================================
    function openDrawerByIndex(globalIdx) {
      const f = filteredFindings[globalIdx];
      if (!f) return;
      openDrawer(f);
    }

    function openDrawer(finding) {
      activeFindingForDrawer = finding;
      const chainMeta = getChainMeta(finding.chainId || finding.chainAlias);

      // Header
      document.getElementById('drawer-network-badge').textContent = chainMeta.name;
      document.getElementById('drawer-network-badge').className = \`px-2.5 py-1 rounded-full text-xs font-semibold border \${chainMeta.badgeColor}\`;
      document.getElementById('drawer-title').textContent = \`\${finding.tokenSymbol} in \${finding.market}\`;

      // Hero
      const valNum = parseFloat(finding.valueUsd || '0');
      const valEl = document.getElementById('drawer-usd-value');
      if (valNum > 0) {
        valEl.textContent = '+$' + valNum.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        valEl.className = 'text-3xl sm:text-4xl font-extrabold font-mono text-emerald-400 tracking-tight';
      } else if (valNum < 0) {
        valEl.textContent = '-$' + Math.abs(valNum).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        valEl.className = 'text-3xl sm:text-4xl font-extrabold font-mono text-rose-400 tracking-tight';
      } else {
        valEl.textContent = '$0.00';
        valEl.className = 'text-3xl sm:text-4xl font-extrabold font-mono text-tl-fg-muted tracking-tight';
      }

      document.getElementById('drawer-token-amount').textContent = \`\${finding.amountFormatted} \${finding.tokenSymbol}\`;
      document.getElementById('drawer-token-price').textContent = finding.priceUsd ? \`@ $\${parseFloat(finding.priceUsd).toLocaleString('en-US', { maximumFractionDigits: 6 })} / \${finding.tokenSymbol}\` : 'No Oracle Price';
      document.getElementById('drawer-market-tag').textContent = finding.market;

      // Kind badge
      const kindBadgeEl = document.getElementById('drawer-kind-badge');
      if (finding.kind === 'underlying-surplus') {
        if (valNum < 0 || (finding.amount && finding.amount.startsWith('-'))) {
          kindBadgeEl.textContent = 'System Deficit';
          kindBadgeEl.className = 'px-2.5 py-0.5 rounded-full text-xs font-medium bg-tl-error-muted text-tl-error border border-tl-error-border';
        } else {
          kindBadgeEl.textContent = 'Underlying Surplus';
          kindBadgeEl.className = 'px-2.5 py-0.5 rounded-full text-xs font-medium bg-tl-success-muted text-tl-success border border-tl-success-border';
        }
      } else if (finding.kind === 'token-in-pool') {
        kindBadgeEl.textContent = 'Token in Pool (Direct Holding)';
        kindBadgeEl.className = 'px-2.5 py-0.5 rounded-full text-xs font-medium bg-tl-warning-muted text-tl-warning border border-tl-warning-border';
      } else if (finding.kind === 'foreign-token-in-atoken') {
        kindBadgeEl.textContent = 'Foreign Token in aToken';
        kindBadgeEl.className = 'px-2.5 py-0.5 rounded-full text-xs font-medium bg-tl-accent-muted text-tl-accent border border-blue-800';
      } else if (finding.kind === 'atoken-in-itself') {
        kindBadgeEl.textContent = 'aToken in itself (Self-holding)';
        kindBadgeEl.className = 'px-2.5 py-0.5 rounded-full text-xs font-medium bg-tl-accent-muted text-tl-accent border border-blue-800';
      } else if (finding.kind === 'v4-hub-surplus') {
        kindBadgeEl.textContent = 'V4 Hub Surplus';
        kindBadgeEl.className = 'px-2.5 py-0.5 rounded-full text-xs font-medium bg-tl-success-muted text-tl-success border border-tl-success-border';
      } else if (finding.kind === 'v4-hub-deficit') {
        kindBadgeEl.textContent = 'V4 Hub Deficit';
        kindBadgeEl.className = 'px-2.5 py-0.5 rounded-full text-xs font-medium bg-tl-error-muted text-tl-error border border-tl-error-border';
      } else if (finding.kind === 'v4-token-in-spoke') {
        kindBadgeEl.textContent = 'V4 Stuck in Spoke';
        kindBadgeEl.className = 'px-2.5 py-0.5 rounded-full text-xs font-medium bg-tl-warning-muted text-tl-warning border border-tl-warning-border';
      } else if (finding.kind === 'v4-token-in-tokenization-spoke') {
        kindBadgeEl.textContent = 'V4 Stuck in Tokenization Spoke';
        kindBadgeEl.className = 'px-2.5 py-0.5 rounded-full text-xs font-medium bg-tl-warning-muted text-tl-warning border border-tl-warning-border';
      } else if (finding.kind === 'v4-token-in-position-manager') {
        kindBadgeEl.textContent = 'V4 Stuck in Position Manager';
        kindBadgeEl.className = 'px-2.5 py-0.5 rounded-full text-xs font-medium bg-tl-warning-muted text-tl-warning border border-tl-warning-border';
      } else if (finding.kind === 'v4-hub-clean') {
        kindBadgeEl.textContent = 'V4 Hub Verified Clean';
        kindBadgeEl.className = 'px-2.5 py-0.5 rounded-full text-xs font-medium bg-tl-success-muted text-tl-success border border-tl-success-border';
      } else if (finding.kind === 'v4-spoke-clean') {
        kindBadgeEl.textContent = 'V4 Spoke / PM Verified Clean';
        kindBadgeEl.className = 'px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200';
      }

      // Financial breakdown
      document.getElementById('drawer-raw-amount').textContent = finding.amount;
      document.getElementById('drawer-oracle-base').textContent = finding.oracleBaseUnit || '100000000';

      const virtBox = document.getElementById('drawer-virtual-bal-box');
      if (finding.virtualBalance) {
        virtBox.classList.remove('hidden');
        document.getElementById('drawer-virtual-bal-formatted').textContent = formatUnitsFromRaw(finding.virtualBalance, finding.decimals) + ' ' + finding.tokenSymbol;
        document.getElementById('drawer-virtual-bal-raw').textContent = 'Raw Base Units: ' + finding.virtualBalance;
      } else {
        virtBox.classList.add('hidden');
      }

      // Contract details
      document.getElementById('drawer-holder-symbol').textContent = finding.holderSymbol || 'Holder';
      document.getElementById('drawer-holder-addr').textContent = finding.holder;
      document.getElementById('link-holder-explorer').href = getExplorerAddressUrl(finding.chainId, finding.holder);
      document.getElementById('drawer-token-symbol').textContent = finding.tokenSymbol || 'Token';
      document.getElementById('drawer-token-addr').textContent = finding.token;
      document.getElementById('link-token-explorer').href = getExplorerAddressUrl(finding.chainId, finding.token);
      document.getElementById('drawer-pinned-block').textContent = '#' + (finding.pinnedBlock ? finding.pinnedBlock.toLocaleString('en-US') : 'Unknown');
      if (finding.pinnedBlock) {
        document.getElementById('link-pinned-block').href = getExplorerBlockUrl(finding.chainId, finding.pinnedBlock);
      }
      document.getElementById('drawer-pinned-at').textContent = finding.pinnedAt ? new Date(finding.pinnedAt).toLocaleString('en-US', { timeZoneName: 'short' }) : 'N/A';

      // Explanation
      const expEl = document.getElementById('drawer-kind-explanation');
      if (finding.kind === 'underlying-surplus') {
        if (valNum < 0 || (finding.amount && finding.amount.startsWith('-'))) {
          expEl.textContent = 'Deficit detected: The ERC-20 underlying balance held by this aToken is below the virtual reserve balance tracked by the Aave Pool. This represents an accounting disparity that requires protocol attention.';
        } else {
          expEl.textContent = 'Surplus detected: The ERC-20 underlying token balance held by the aToken contract exceeds the pool’s virtual reserve balance. This surplus is safe to rescue and transfer to the Aave Collector or Treasury.';
        }
      } else if (finding.kind === 'token-in-pool') {
        expEl.textContent = 'Direct Pool Holding: Tokens were transferred directly into the Aave Pool contract address. The Pool contract does not hold liquidity directly (liquidity is held by aTokens). These tokens can be extracted via the Pool.rescueTokens(token, to, amount) function.';
      } else if (finding.kind === 'foreign-token-in-atoken') {
        expEl.textContent = 'Foreign Asset: This aToken contract holds an ERC-20 token different from its own underlying asset. These usually result from accidental user transfers or distributions and can be recovered via governance rescue proposals.';
      } else if (finding.kind === 'atoken-in-itself') {
        expEl.textContent = 'Self-Holding: The aToken holds a balance of its own token address. This commonly happens when tokens are mistakenly minted or transferred to the token contract itself, and can be rescued through governance intervention.';
      } else if (finding.kind === 'v4-hub-surplus') {
        expEl.textContent = 'V4 Hub Surplus: The ERC-20 balance held by this V4 Hub exceeds its accounting balance (liquidity + accrued fees). This surplus can be rescued by the protocol.';
      } else if (finding.kind === 'v4-hub-deficit') {
        expEl.textContent = 'V4 Hub Deficit: The ERC-20 balance held by this V4 Hub is lower than its accounting balance (liquidity + accrued fees). This may reflect accrued protocol interest or uncollected fees.';
      } else if (finding.kind === 'v4-token-in-spoke') {
        expEl.textContent = 'V4 Stuck Token in Spoke: Aave V4 Spokes do not custody underlying tokens (all liquidity is held in Hubs). Any non-zero ERC-20 balance indicates tokens sent mistakenly to the Spoke contract.';
      } else if (finding.kind === 'v4-token-in-tokenization-spoke') {
        expEl.textContent = 'V4 Stuck Token in Tokenization Spoke: Tokenization Spokes act as ERC-4626 pass-through vaults and should not hold persistent token balances. Any positive balance is rescueable.';
      } else if (finding.kind === 'v4-token-in-position-manager') {
        expEl.textContent = 'V4 Stuck Token in Position Manager: Position Managers and Gateways are transient execution routers. Any persistent token balance indicates stuck funds that can be rescued by the rescue guardian.';
      } else if (finding.kind === 'v4-hub-clean') {
        expEl.textContent = 'V4 Hub Verified Clean: The ERC-20 balance held by this V4 Hub exactly matches its internal accounting (liquidity balance). No excess balance or deficit detected.';
      } else if (finding.kind === 'v4-spoke-clean') {
        expEl.textContent = 'V4 Spoke / PM Verified Clean: This contract (Spoke, Position Manager, or Gateway) holds 0 token balance across all scanned assets. No stuck funds detected.';
      }

      // Note
      const noteBox = document.getElementById('drawer-note-container');
      const noteText = document.getElementById('drawer-note-text');
      if (finding.note) {
        noteBox.classList.remove('hidden');
        noteText.textContent = finding.note;
      } else {
        noteBox.classList.add('hidden');
      }

      // Show Drawer & Backdrop
      const backdrop = document.getElementById('drawer-backdrop');
      const drawer = document.getElementById('detail-drawer');
      backdrop.classList.remove('opacity-0', 'pointer-events-none');
      drawer.classList.remove('translate-x-full');
      document.body.style.overflow = 'hidden';
    }

    function closeDrawer() {
      const backdrop = document.getElementById('drawer-backdrop');
      const drawer = document.getElementById('detail-drawer');
      backdrop.classList.add('opacity-0', 'pointer-events-none');
      drawer.classList.add('translate-x-full');
      document.body.style.overflow = '';
      activeFindingForDrawer = null;
    }

    // ========================================================================
    // CSV and JSON Exports
    // ========================================================================
    function exportCsv() {
      if (filteredFindings.length === 0) {
        showToast('No findings to export');
        return;
      }

      const headers = [
        'Network', 'Chain ID', 'Market', 'Kind', 'Holder Symbol', 'Holder Address',
        'Token Symbol', 'Token Address', 'Decimals', 'Raw Base Units', 'Amount Formatted',
        'Virtual Balance Raw', 'Oracle Price USD', 'Value USD', 'Pinned Block', 'Pinned At', 'Notes'
      ];

      function escapeCell(val) {
        if (val === undefined || val === null) return '""';
        const str = String(val);
        if (str.includes(',') || str.includes('"') || str.includes('\\n')) {
          return '"' + str.replace(/"/g, '""') + '"';
        }
        return '"' + str + '"';
      }

      const rows = filteredFindings.map(f => [
        escapeCell(f.chainAlias),
        escapeCell(f.chainId),
        escapeCell(f.market),
        escapeCell(f.kind),
        escapeCell(f.holderSymbol),
        escapeCell(f.holder),
        escapeCell(f.tokenSymbol),
        escapeCell(f.token),
        escapeCell(f.decimals),
        escapeCell(f.amount),
        escapeCell(f.amountFormatted),
        escapeCell(f.virtualBalance || ''),
        escapeCell(f.priceUsd || ''),
        escapeCell(f.valueUsd || '0.00'),
        escapeCell(f.pinnedBlock || ''),
        escapeCell(f.pinnedAt || ''),
        escapeCell(f.note || '')
      ].join(','));

      const csvContent = [headers.map(escapeCell).join(','), ...rows].join('\\r\\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = \`aave-v3-rescue-findings-\${new Date().toISOString().slice(0, 10)}.csv\`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast(\`Exported \${filteredFindings.length} findings to CSV\`);
    }

    function exportJson() {
      if (filteredFindings.length === 0) {
        showToast('No findings to export');
        return;
      }

      const jsonStr = JSON.stringify(filteredFindings, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = \`aave-v3-rescue-findings-\${new Date().toISOString().slice(0, 10)}.json\`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast(\`Exported \${filteredFindings.length} findings to JSON\`);
    }

    // ========================================================================
    // Event Listeners Setup
    // ========================================================================
    document.addEventListener('DOMContentLoaded', () => {
      initData();

      // Search input with live debounced filter
      const searchInput = document.getElementById('search-input');
      const clearSearchBtn = document.getElementById('btn-clear-search');

      let searchTimeout = null;
      searchInput.addEventListener('input', (e) => {
        const val = e.target.value;
        clearSearchBtn.classList.toggle('hidden', !val);
        if (searchTimeout) clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
          filters.search = val;
          applyFilters();
        }, 120);
      });

      clearSearchBtn.addEventListener('click', () => {
        searchInput.value = '';
        clearSearchBtn.classList.add('hidden');
        filters.search = '';
        applyFilters();
        searchInput.focus();
      });

      // Keyboard shortcut '/' to focus search
      window.addEventListener('keydown', (e) => {
        if (e.key === '/' && document.activeElement !== searchInput) {
          e.preventDefault();
          searchInput.focus();
        }
        if (e.key === 'Escape') {
          closeDrawer();
        }
      });

      // Category filter dropdown
      document.getElementById('category-filter').addEventListener('change', (e) => {
        filters.category = e.target.value;
        applyFilters();
      });

      // Dust filter checkbox
      document.getElementById('dust-filter').addEventListener('change', (e) => {
        filters.hideDust = e.target.checked;
        renderNetworkPills();
        renderProtocolPills();
        applyFilters();
      });

      // Reset filters button
      const resetAction = () => {
        filters.network = 'all';
        filters.protocol = 'all';
        filters.category = 'all';
        filters.search = '';
        filters.hideDust = true;
        searchInput.value = '';
        clearSearchBtn.classList.add('hidden');
        document.getElementById('category-filter').value = 'all';
        document.getElementById('dust-filter').checked = true;
        renderNetworkPills();
        renderProtocolPills();
        applyFilters();
        showToast('Filters reset to default');
      };

      document.getElementById('btn-reset-filters').addEventListener('click', resetAction);
      document.getElementById('btn-empty-reset').addEventListener('click', resetAction);

      // Toggle zero findings networks
      document.getElementById('btn-toggle-zero-chains').addEventListener('click', (e) => {
        showZeroChains = !showZeroChains;
        e.target.textContent = showZeroChains ? 'Hide 0-finding networks' : 'Show 0-finding networks';
        renderNetworkPills();
      });

      // Page size dropdown
      document.getElementById('page-size-select').addEventListener('change', (e) => {
        paginationState.pageSize = e.target.value;
        paginationState.currentPage = 1;
        renderTable();
      });

      // Sort headers
      document.querySelectorAll('th[data-sort]').forEach(th => {
        th.addEventListener('click', () => {
          const col = th.getAttribute('data-sort');
          if (sortState.column === col) {
            sortState.order = sortState.order === 'asc' ? 'desc' : 'asc';
          } else {
            sortState.column = col;
            sortState.order = (col === 'value' || col === 'amount') ? 'desc' : 'asc';
          }

          // Update header icons
          document.querySelectorAll('.sort-icon').forEach(icon => {
            const iconCol = icon.getAttribute('data-col');
            if (iconCol === sortState.column) {
              icon.textContent = sortState.order === 'asc' ? '▲' : '▼';
              icon.className = 'sort-icon text-tl-aave text-[10px]';
            } else {
              icon.textContent = '⇅';
              icon.className = 'sort-icon text-tl-fg-disabled text-[10px]';
            }
          });

          applySorting();
          renderTable();
        });
      });

      // Drawer close handlers
      document.getElementById('btn-close-drawer').addEventListener('click', closeDrawer);
      document.getElementById('btn-drawer-done').addEventListener('click', closeDrawer);
      document.getElementById('drawer-backdrop').addEventListener('click', closeDrawer);

      // Drawer copy buttons
      document.getElementById('btn-copy-raw-amount').addEventListener('click', function() {
        if (activeFindingForDrawer) {
          copyToClipboard(activeFindingForDrawer.amount, 'Copied exact raw amount', this);
        }
      });

      document.getElementById('btn-copy-holder-addr').addEventListener('click', function() {
        if (activeFindingForDrawer) {
          copyToClipboard(activeFindingForDrawer.holder, 'Copied holder address', this);
        }
      });

      document.getElementById('btn-copy-token-addr').addEventListener('click', function() {
        if (activeFindingForDrawer) {
          copyToClipboard(activeFindingForDrawer.token, 'Copied token address', this);
        }
      });

      document.getElementById('btn-copy-finding-json').addEventListener('click', function() {
        if (activeFindingForDrawer) {
          copyToClipboard(JSON.stringify(activeFindingForDrawer, null, 2), 'Copied full finding JSON', this);
        }
      });

      // Export buttons
      document.getElementById('btn-export-csv').addEventListener('click', exportCsv);
      document.getElementById('btn-export-json').addEventListener('click', exportJson);
    });
  </script>

</body>
</html>
`;

const outputPath = path.resolve(__dirname, "../docs/index.html");
fs.writeFileSync(outputPath, htmlContent, "utf8");
console.log(
  `Successfully generated docs/index.html (${htmlContent.length} bytes)`
);
