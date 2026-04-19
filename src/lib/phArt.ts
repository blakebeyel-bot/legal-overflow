// SVG illustrations for article cover placeholders.
// Each article's frontmatter picks one via the `cover` field.

// Labeled list of cover illustrations. The `id` is the frontmatter value
// stored per article. The `label` is what shows in the CMS dropdown.
export const coverOptions = [
  { id: 'ph-a', label: 'Contract graph (two documents)' },
  { id: 'ph-b', label: 'Courthouse columns' },
  { id: 'ph-c', label: 'Workflow triage (kanban)' },
  { id: 'ph-d', label: 'Building with lit window' },
  { id: 'ph-e', label: 'Redacted transcript' },
  { id: 'ph-f', label: 'Stack of books' },
  { id: 'ph-g', label: 'Neural network' },
  { id: 'ph-h', label: 'Scales of justice' },
  { id: 'ph-i', label: 'Gavel' },
  { id: 'ph-j', label: 'Clock face' },
  { id: 'ph-k', label: 'Wax seal on document' },
  { id: 'ph-l', label: 'Padlock (privilege / security)' },
  { id: 'ph-m', label: 'Compass rose' },
] as const;

export const phArt: Record<string, string> = {
  'ph-a': `<svg class="ph-art" viewBox="0 0 500 400" fill="none" aria-hidden="true" preserveAspectRatio="xMidYMid meet">
    <g stroke="rgba(14,21,18,.55)" stroke-width="1.2" fill="rgba(255,255,255,.28)">
      <rect x="90" y="80" width="140" height="240" rx="2"/>
      <rect x="270" y="80" width="140" height="240" rx="2"/>
    </g>
    <g stroke="rgba(14,21,18,.32)" stroke-width="1">
      <line x1="108" y1="110" x2="215" y2="110"/>
      <line x1="108" y1="128" x2="205" y2="128"/>
      <line x1="108" y1="146" x2="212" y2="146"/>
      <line x1="108" y1="170" x2="200" y2="170"/>
      <line x1="108" y1="188" x2="215" y2="188"/>
      <line x1="108" y1="206" x2="210" y2="206"/>
      <line x1="108" y1="230" x2="215" y2="230"/>
      <line x1="108" y1="248" x2="195" y2="248"/>
      <line x1="108" y1="272" x2="210" y2="272"/>
      <line x1="108" y1="290" x2="205" y2="290"/>
      <line x1="288" y1="110" x2="395" y2="110"/>
      <line x1="288" y1="128" x2="385" y2="128"/>
      <line x1="288" y1="146" x2="392" y2="146"/>
      <line x1="288" y1="170" x2="380" y2="170"/>
      <line x1="288" y1="188" x2="395" y2="188"/>
      <line x1="288" y1="206" x2="390" y2="206"/>
      <line x1="288" y1="230" x2="395" y2="230"/>
      <line x1="288" y1="248" x2="375" y2="248"/>
      <line x1="288" y1="272" x2="390" y2="272"/>
      <line x1="288" y1="290" x2="385" y2="290"/>
    </g>
    <g stroke="#0a7d57" stroke-width="1" fill="none" opacity=".75">
      <path d="M230 110 Q250 110 270 110"/>
      <path d="M230 146 Q250 146 270 146"/>
      <path d="M230 188 Q250 188 270 188"/>
      <path d="M230 230 Q250 230 270 230"/>
      <path d="M230 272 Q250 272 270 272"/>
    </g>
    <g fill="#0a7d57">
      <circle cx="250" cy="110" r="3"/>
      <circle cx="250" cy="146" r="3"/>
      <circle cx="250" cy="188" r="3"/>
      <circle cx="250" cy="230" r="3"/>
      <circle cx="250" cy="272" r="3"/>
    </g>
  </svg>`,

  'ph-b': `<svg class="ph-art" viewBox="0 0 400 300" fill="none" aria-hidden="true" preserveAspectRatio="xMidYMid meet">
    <path d="M100 90 L200 50 L300 90" stroke="rgba(14,21,18,.55)" stroke-width="1.4" fill="none" stroke-linejoin="round"/>
    <rect x="100" y="90" width="200" height="14" stroke="rgba(14,21,18,.55)" stroke-width="1.4" fill="none"/>
    <g stroke="rgba(14,21,18,.55)" stroke-width="1.3" fill="rgba(255,255,255,.2)">
      <rect x="114" y="108" width="10" height="122"/>
      <rect x="150" y="108" width="10" height="122"/>
      <rect x="222" y="108" width="10" height="122"/>
      <rect x="258" y="108" width="10" height="122"/>
    </g>
    <rect x="186" y="108" width="10" height="122" stroke="rgba(14,21,18,.55)" stroke-width="1.3" fill="rgba(255,255,255,.2)"/>
    <path d="M191 140 L189 160 L194 175 L190 195 L192 220" stroke="#0a7d57" stroke-width="1.5" fill="none"/>
    <line x1="90" y1="232" x2="310" y2="232" stroke="rgba(14,21,18,.55)" stroke-width="1.3"/>
    <line x1="100" y1="242" x2="300" y2="242" stroke="rgba(14,21,18,.35)" stroke-width="1"/>
    <line x1="110" y1="252" x2="290" y2="252" stroke="rgba(14,21,18,.35)" stroke-width="1"/>
  </svg>`,

  'ph-c': `<svg class="ph-art" viewBox="0 0 400 300" fill="none" aria-hidden="true" preserveAspectRatio="xMidYMid meet">
    <g stroke="rgba(14,21,18,.4)" stroke-width="1">
      <line x1="50" y1="60" x2="125" y2="60"/>
      <line x1="163" y1="60" x2="238" y2="60"/>
      <line x1="275" y1="60" x2="350" y2="60"/>
    </g>
    <g stroke="rgba(14,21,18,.5)" stroke-width="1" fill="rgba(255,255,255,.3)">
      <rect x="55" y="78" width="65" height="16"/>
      <rect x="55" y="100" width="65" height="16"/>
      <rect x="55" y="122" width="65" height="16"/>
      <rect x="55" y="144" width="65" height="16"/>
      <rect x="55" y="166" width="65" height="16"/>
      <rect x="55" y="188" width="65" height="16"/>
      <rect x="55" y="210" width="65" height="16"/>
      <rect x="168" y="100" width="65" height="16"/>
      <rect x="168" y="128" width="65" height="16"/>
      <rect x="168" y="156" width="65" height="16"/>
      <rect x="168" y="184" width="65" height="16"/>
      <rect x="280" y="140" width="65" height="16"/>
    </g>
    <rect x="280" y="164" width="65" height="22" stroke="#0a7d57" stroke-width="1.6" fill="rgba(10,125,87,.1)"/>
    <line x1="288" y1="172" x2="338" y2="172" stroke="#0a7d57" stroke-width="1"/>
    <line x1="288" y1="178" x2="330" y2="178" stroke="#0a7d57" stroke-width="1"/>
    <g stroke="rgba(14,21,18,.45)" stroke-width="1" fill="none" stroke-linecap="round">
      <path d="M128 130 L160 130 M155 126 L160 130 L155 134"/>
      <path d="M240 160 L272 160 M267 156 L272 160 L267 164"/>
    </g>
  </svg>`,

  'ph-d': `<svg class="ph-art" viewBox="0 0 400 300" fill="none" aria-hidden="true" preserveAspectRatio="xMidYMid meet">
    <rect x="90" y="70" width="220" height="175" stroke="rgba(14,21,18,.55)" stroke-width="1.2" fill="rgba(14,21,18,.05)"/>
    <g fill="rgba(14,21,18,.18)">
      <rect x="106" y="88" width="22" height="14"/><rect x="138" y="88" width="22" height="14"/><rect x="170" y="88" width="22" height="14"/><rect x="202" y="88" width="22" height="14"/><rect x="234" y="88" width="22" height="14"/><rect x="266" y="88" width="22" height="14"/>
      <rect x="106" y="112" width="22" height="14"/><rect x="138" y="112" width="22" height="14"/><rect x="170" y="112" width="22" height="14"/><rect x="234" y="112" width="22" height="14"/><rect x="266" y="112" width="22" height="14"/>
      <rect x="106" y="136" width="22" height="14"/><rect x="138" y="136" width="22" height="14"/><rect x="170" y="136" width="22" height="14"/><rect x="202" y="136" width="22" height="14"/><rect x="234" y="136" width="22" height="14"/><rect x="266" y="136" width="22" height="14"/>
      <rect x="106" y="160" width="22" height="14"/><rect x="138" y="160" width="22" height="14"/><rect x="170" y="160" width="22" height="14"/><rect x="202" y="160" width="22" height="14"/><rect x="234" y="160" width="22" height="14"/><rect x="266" y="160" width="22" height="14"/>
      <rect x="106" y="184" width="22" height="14"/><rect x="138" y="184" width="22" height="14"/><rect x="170" y="184" width="22" height="14"/><rect x="202" y="184" width="22" height="14"/><rect x="234" y="184" width="22" height="14"/><rect x="266" y="184" width="22" height="14"/>
      <rect x="106" y="208" width="22" height="14"/><rect x="138" y="208" width="22" height="14"/><rect x="170" y="208" width="22" height="14"/><rect x="202" y="208" width="22" height="14"/><rect x="234" y="208" width="22" height="14"/><rect x="266" y="208" width="22" height="14"/>
    </g>
    <rect x="202" y="112" width="22" height="14" fill="#0a7d57"/>
    <line x1="60" y1="245" x2="340" y2="245" stroke="rgba(14,21,18,.45)" stroke-width="1"/>
  </svg>`,

  'ph-e': `<svg class="ph-art" viewBox="0 0 400 300" fill="none" aria-hidden="true" preserveAspectRatio="xMidYMid meet">
    <rect x="60" y="40" width="280" height="220" stroke="rgba(14,21,18,.3)" stroke-width="1" fill="rgba(255,255,255,.25)"/>
    <g stroke="rgba(14,21,18,.5)" stroke-width="1.4" stroke-linecap="round">
      <line x1="80" y1="62" x2="300" y2="62"/>
      <line x1="80" y1="80" x2="320" y2="80"/>
    </g>
    <rect x="80" y="92" width="220" height="9" fill="rgba(14,21,18,.85)"/>
    <g stroke="rgba(14,21,18,.5)" stroke-width="1.4" stroke-linecap="round">
      <line x1="80" y1="120" x2="310" y2="120"/>
      <line x1="80" y1="138" x2="280" y2="138"/>
    </g>
    <rect x="80" y="150" width="160" height="9" fill="rgba(14,21,18,.85)"/>
    <g stroke="rgba(14,21,18,.5)" stroke-width="1.4" stroke-linecap="round">
      <line x1="80" y1="178" x2="315" y2="178"/>
      <line x1="80" y1="196" x2="290" y2="196"/>
      <line x1="80" y1="218" x2="260" y2="218"/>
    </g>
    <line x1="80" y1="224" x2="200" y2="224" stroke="#0a7d57" stroke-width="1.4"/>
    <line x1="80" y1="240" x2="295" y2="240" stroke="rgba(14,21,18,.5)" stroke-width="1.4" stroke-linecap="round"/>
  </svg>`,

  'ph-f': `<svg class="ph-art" viewBox="0 0 400 300" fill="none" aria-hidden="true" preserveAspectRatio="xMidYMid meet">
    <g stroke="rgba(14,21,18,.55)" stroke-width="1.3" fill="rgba(255,255,255,.3)">
      <rect x="88" y="218" width="224" height="26"/>
      <rect x="98" y="190" width="204" height="26"/>
      <rect x="84" y="162" width="218" height="26"/>
      <rect x="106" y="134" width="192" height="26"/>
      <rect x="94" y="106" width="212" height="26"/>
    </g>
    <g stroke="rgba(14,21,18,.3)" stroke-width="1">
      <line x1="108" y1="230" x2="290" y2="230"/>
      <line x1="118" y1="202" x2="280" y2="202"/>
      <line x1="102" y1="174" x2="285" y2="174"/>
      <line x1="126" y1="146" x2="280" y2="146"/>
      <line x1="114" y1="118" x2="285" y2="118"/>
    </g>
    <g stroke="rgba(14,21,18,.5)" stroke-width="1.2" stroke-linecap="round">
      <line x1="130" y1="236" x2="175" y2="236"/>
      <line x1="140" y1="208" x2="180" y2="208"/>
      <line x1="124" y1="180" x2="170" y2="180"/>
      <line x1="148" y1="152" x2="185" y2="152"/>
      <line x1="134" y1="124" x2="175" y2="124"/>
    </g>
    <path d="M210 106 L210 168 L204 161 L198 168 L198 106 Z" fill="#0a7d57"/>
  </svg>`,

  'ph-g': `<svg class="ph-art" viewBox="0 0 400 300" fill="none" aria-hidden="true" preserveAspectRatio="xMidYMid meet">
    <g stroke="rgba(14,21,18,.25)" stroke-width="1">
      <line x1="80" y1="100" x2="170" y2="70"/>
      <line x1="80" y1="100" x2="150" y2="150"/>
      <line x1="80" y1="100" x2="100" y2="210"/>
      <line x1="170" y1="70" x2="250" y2="100"/>
      <line x1="170" y1="70" x2="230" y2="170"/>
      <line x1="150" y1="150" x2="230" y2="170"/>
      <line x1="150" y1="150" x2="200" y2="230"/>
      <line x1="100" y1="210" x2="200" y2="230"/>
      <line x1="200" y1="230" x2="290" y2="220"/>
      <line x1="230" y1="170" x2="290" y2="220"/>
      <line x1="250" y1="100" x2="310" y2="130"/>
      <line x1="250" y1="100" x2="320" y2="60"/>
      <line x1="310" y1="130" x2="340" y2="80"/>
      <line x1="290" y1="220" x2="340" y2="80"/>
    </g>
    <g stroke="#0a7d57" stroke-width="1.4" opacity=".85">
      <line x1="150" y1="150" x2="230" y2="170"/>
      <line x1="230" y1="170" x2="310" y2="130"/>
    </g>
    <g fill="rgba(14,21,18,.7)">
      <circle cx="80" cy="100" r="3.5"/>
      <circle cx="170" cy="70" r="3.5"/>
      <circle cx="250" cy="100" r="3.5"/>
      <circle cx="320" cy="60" r="3.5"/>
      <circle cx="100" cy="210" r="3.5"/>
      <circle cx="200" cy="230" r="3.5"/>
      <circle cx="290" cy="220" r="3.5"/>
      <circle cx="340" cy="80" r="3.5"/>
    </g>
    <g fill="#0a7d57">
      <circle cx="150" cy="150" r="4.5"/>
      <circle cx="230" cy="170" r="4.5"/>
      <circle cx="310" cy="130" r="4.5"/>
    </g>
  </svg>`,

  'ph-h': `<svg class="ph-art" viewBox="0 0 400 300" fill="none" aria-hidden="true" preserveAspectRatio="xMidYMid meet">
    <rect x="185" y="240" width="30" height="12" stroke="rgba(14,21,18,.55)" stroke-width="1.3" fill="rgba(255,255,255,.2)"/>
    <rect x="150" y="252" width="100" height="8" stroke="rgba(14,21,18,.55)" stroke-width="1.3" fill="rgba(255,255,255,.2)"/>
    <line x1="200" y1="90" x2="200" y2="240" stroke="rgba(14,21,18,.55)" stroke-width="1.5"/>
    <line x1="110" y1="90" x2="290" y2="90" stroke="rgba(14,21,18,.55)" stroke-width="1.5"/>
    <circle cx="200" cy="90" r="5" fill="#0a7d57"/>
    <line x1="110" y1="90" x2="130" y2="145" stroke="rgba(14,21,18,.35)" stroke-width="1"/>
    <line x1="110" y1="90" x2="90" y2="145" stroke="rgba(14,21,18,.35)" stroke-width="1"/>
    <path d="M80 145 Q110 165 140 145" stroke="rgba(14,21,18,.55)" stroke-width="1.4" fill="rgba(255,255,255,.2)"/>
    <line x1="80" y1="145" x2="140" y2="145" stroke="rgba(14,21,18,.55)" stroke-width="1.4"/>
    <line x1="290" y1="90" x2="270" y2="155" stroke="rgba(14,21,18,.35)" stroke-width="1"/>
    <line x1="290" y1="90" x2="310" y2="155" stroke="rgba(14,21,18,.35)" stroke-width="1"/>
    <path d="M260 155 Q290 177 320 155" stroke="rgba(14,21,18,.55)" stroke-width="1.4" fill="rgba(255,255,255,.2)"/>
    <line x1="260" y1="155" x2="320" y2="155" stroke="rgba(14,21,18,.55)" stroke-width="1.4"/>
    <circle cx="290" cy="150" r="4" fill="#0a7d57"/>
    <circle cx="278" cy="148" r="3" fill="rgba(14,21,18,.4)"/>
    <circle cx="302" cy="148" r="3" fill="rgba(14,21,18,.4)"/>
  </svg>`,

  'ph-i': `<svg class="ph-art" viewBox="0 0 400 300" fill="none" aria-hidden="true" preserveAspectRatio="xMidYMid meet">
    <rect x="100" y="220" width="200" height="18" stroke="rgba(14,21,18,.55)" stroke-width="1.3" fill="rgba(255,255,255,.25)"/>
    <rect x="90" y="238" width="220" height="10" stroke="rgba(14,21,18,.55)" stroke-width="1.3" fill="rgba(14,21,18,.08)"/>
    <g stroke="rgba(14,21,18,.35)" stroke-width="1">
      <line x1="120" y1="230" x2="280" y2="230"/>
    </g>
    <line x1="110" y1="160" x2="240" y2="105" stroke="rgba(14,21,18,.55)" stroke-width="4.5" stroke-linecap="round"/>
    <g transform="rotate(-22 250 105)">
      <rect x="220" y="88" width="70" height="34" rx="3" stroke="rgba(14,21,18,.55)" stroke-width="1.4" fill="rgba(255,255,255,.35)"/>
      <line x1="242" y1="88" x2="242" y2="122" stroke="rgba(14,21,18,.4)" stroke-width="1"/>
      <line x1="268" y1="88" x2="268" y2="122" stroke="rgba(14,21,18,.4)" stroke-width="1"/>
    </g>
    <g fill="#0a7d57">
      <circle cx="115" cy="218" r="2.5"/>
      <circle cx="105" cy="210" r="1.8"/>
      <circle cx="125" cy="210" r="1.8"/>
    </g>
    <line x1="100" y1="206" x2="95" y2="198" stroke="#0a7d57" stroke-width="1.3" stroke-linecap="round"/>
    <line x1="130" y1="206" x2="135" y2="198" stroke="#0a7d57" stroke-width="1.3" stroke-linecap="round"/>
    <line x1="110" y1="202" x2="110" y2="195" stroke="#0a7d57" stroke-width="1.3" stroke-linecap="round"/>
  </svg>`,

  'ph-j': `<svg class="ph-art" viewBox="0 0 400 300" fill="none" aria-hidden="true" preserveAspectRatio="xMidYMid meet">
    <circle cx="200" cy="150" r="75" stroke="rgba(14,21,18,.55)" stroke-width="1.4" fill="rgba(255,255,255,.2)"/>
    <circle cx="200" cy="150" r="68" stroke="rgba(14,21,18,.2)" stroke-width="1" fill="none"/>
    <g stroke="rgba(14,21,18,.6)" stroke-width="1.6" stroke-linecap="round">
      <line x1="200" y1="82" x2="200" y2="92"/>
      <line x1="268" y1="150" x2="258" y2="150"/>
      <line x1="200" y1="218" x2="200" y2="208"/>
      <line x1="132" y1="150" x2="142" y2="150"/>
    </g>
    <g stroke="rgba(14,21,18,.3)" stroke-width="1" stroke-linecap="round">
      <line x1="234" y1="90" x2="231" y2="97"/>
      <line x1="260" y1="116" x2="253" y2="119"/>
      <line x1="260" y1="184" x2="253" y2="181"/>
      <line x1="234" y1="210" x2="231" y2="203"/>
      <line x1="166" y1="210" x2="169" y2="203"/>
      <line x1="140" y1="184" x2="147" y2="181"/>
      <line x1="140" y1="116" x2="147" y2="119"/>
      <line x1="166" y1="90" x2="169" y2="97"/>
    </g>
    <line x1="200" y1="150" x2="230" y2="118" stroke="rgba(14,21,18,.75)" stroke-width="2.6" stroke-linecap="round"/>
    <line x1="200" y1="150" x2="170" y2="102" stroke="rgba(14,21,18,.75)" stroke-width="2" stroke-linecap="round"/>
    <line x1="200" y1="150" x2="225" y2="195" stroke="#0a7d57" stroke-width="1.6" stroke-linecap="round"/>
    <circle cx="200" cy="150" r="4" fill="rgba(14,21,18,.85)"/>
    <circle cx="200" cy="150" r="1.8" fill="#0a7d57"/>
  </svg>`,

  'ph-k': `<svg class="ph-art" viewBox="0 0 400 300" fill="none" aria-hidden="true" preserveAspectRatio="xMidYMid meet">
    <rect x="80" y="50" width="240" height="200" stroke="rgba(14,21,18,.3)" stroke-width="1" fill="rgba(255,255,255,.22)"/>
    <g stroke="rgba(14,21,18,.25)" stroke-width="1" stroke-linecap="round">
      <line x1="100" y1="78" x2="280" y2="78"/>
      <line x1="100" y1="94" x2="260" y2="94"/>
      <line x1="100" y1="110" x2="275" y2="110"/>
      <line x1="100" y1="126" x2="250" y2="126"/>
    </g>
    <path d="M180 215 L180 262 L197 248 L214 262 L214 215 Z" fill="#0a7d57" opacity=".9"/>
    <circle cx="197" cy="200" r="42" fill="#0a7d57"/>
    <g fill="#10b981">
      <circle cx="197" cy="158" r="4"/><circle cx="219" cy="163" r="4"/><circle cx="234" cy="180" r="4"/><circle cx="239" cy="200" r="4"/>
      <circle cx="234" cy="220" r="4"/><circle cx="219" cy="237" r="4"/><circle cx="197" cy="242" r="4"/><circle cx="175" cy="237" r="4"/>
      <circle cx="160" cy="220" r="4"/><circle cx="155" cy="200" r="4"/><circle cx="160" cy="180" r="4"/><circle cx="175" cy="163" r="4"/>
    </g>
    <circle cx="197" cy="200" r="28" stroke="rgba(255,255,255,.45)" stroke-width="1" fill="none"/>
    <g stroke="rgba(255,255,255,.9)" stroke-width="1.6" fill="none" stroke-linecap="round">
      <line x1="185" y1="190" x2="209" y2="210"/>
      <line x1="209" y1="190" x2="185" y2="210"/>
    </g>
    <circle cx="197" cy="200" r="14" stroke="rgba(255,255,255,.5)" stroke-width="1" fill="none"/>
  </svg>`,

  'ph-l': `<svg class="ph-art" viewBox="0 0 400 300" fill="none" aria-hidden="true" preserveAspectRatio="xMidYMid meet">
    <path d="M165 130 L165 100 Q165 72 200 72 Q235 72 235 100 L235 130" stroke="rgba(14,21,18,.55)" stroke-width="4.5" fill="none" stroke-linecap="round"/>
    <path d="M170 130 L170 100 Q170 77 200 77 Q230 77 230 100 L230 130" stroke="rgba(14,21,18,.2)" stroke-width="1" fill="none"/>
    <rect x="140" y="128" width="120" height="112" rx="8" stroke="rgba(14,21,18,.55)" stroke-width="1.5" fill="rgba(255,255,255,.3)"/>
    <rect x="146" y="134" width="108" height="100" rx="5" stroke="rgba(14,21,18,.2)" stroke-width="1" fill="none"/>
    <circle cx="200" cy="172" r="12" fill="#0a7d57"/>
    <path d="M194 178 L193 210 L207 210 L206 178 Z" fill="#0a7d57"/>
  </svg>`,

  'ph-m': `<svg class="ph-art" viewBox="0 0 400 300" fill="none" aria-hidden="true" preserveAspectRatio="xMidYMid meet">
    <circle cx="200" cy="150" r="82" stroke="rgba(14,21,18,.55)" stroke-width="1.4" fill="rgba(255,255,255,.18)"/>
    <circle cx="200" cy="150" r="52" stroke="rgba(14,21,18,.3)" stroke-width="1" fill="none"/>
    <g stroke="rgba(14,21,18,.6)" stroke-width="1.5" stroke-linecap="round">
      <line x1="200" y1="68" x2="200" y2="78"/>
      <line x1="282" y1="150" x2="272" y2="150"/>
      <line x1="200" y1="232" x2="200" y2="222"/>
      <line x1="118" y1="150" x2="128" y2="150"/>
    </g>
    <g stroke="rgba(14,21,18,.3)" stroke-width="1" stroke-linecap="round">
      <line x1="258" y1="92" x2="252" y2="98"/>
      <line x1="258" y1="208" x2="252" y2="202"/>
      <line x1="142" y1="208" x2="148" y2="202"/>
      <line x1="142" y1="92" x2="148" y2="98"/>
    </g>
    <path d="M200 150 L192 90 L200 98 L208 90 Z" fill="#0a7d57"/>
    <path d="M200 150 L192 210 L200 202 L208 210 Z" fill="rgba(14,21,18,.6)"/>
    <path d="M200 150 L260 142 L250 150 L260 158 Z" fill="rgba(14,21,18,.3)"/>
    <path d="M200 150 L140 142 L150 150 L140 158 Z" fill="rgba(14,21,18,.3)"/>
    <circle cx="200" cy="150" r="4.5" fill="rgba(14,21,18,.85)"/>
    <circle cx="200" cy="150" r="2" fill="#0a7d57"/>
  </svg>`,
};

export function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
}

export function trackLabel(track: 'legal' | 'business' | 'both'): string {
  if (track === 'both') return 'Legal + Business';
  return track === 'legal' ? 'Legal' : 'Business';
}

export function trackClass(track: 'legal' | 'business' | 'both'): string {
  if (track === 'both') return 'track-both';
  return track === 'legal' ? 'track-legal' : 'track-biz';
}
