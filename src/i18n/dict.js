// Bilingual content dictionary: English (en) + Bahasa Indonesia (id).
// Both objects share the SAME shape so components can index either safely.
// Language-independent data (contact info, socials, client logos, image
// paths, routes) lives in src/data/site.js — not here.

export const dict = {
  en: {
    langName: 'English',
    nav: { home: 'Home', about: 'About Us', service: 'Service', services: 'Services', contact: 'Contact Us' },
    common: {
      startEvent: 'Start your event',
      exploreMore: 'Explore More',
      sendInquiry: 'Send Inquiry',
      sendingInquiry: 'Opening your email…',
      location: 'Location',
      brandTag: 'EVENTS',
      close: 'Close',
      chatWithUs: 'Chat with us',
      talkFurther: "Let's Talk Further",
    },
    intro: {
      clickLogo: 'click logo to start',
      knowMore: 'Click to Experience',
      skip: 'Skip',
      skipAd: 'Click to Skip',
      close: 'Close',
      showreelLabel: 'Oscenia showreel',
    },
    hero: {
      // The hero sets this sentence as ten separately-sized fragments across
      // three lines — see components/KineticHeadline.jsx, which owns the
      // typography and reads this array in order. `tagline` stays as the plain
      // sentence for anywhere the styled version does not belong.
      headline: [
        ['Strategic events', '&', 'immersive'],
        ['experiences that', 'transform', 'business'],
        ['objectives', 'into', 'memorable human', 'moments.'],
      ],
      tagline:
        'Strategic events and immersive experiences that transform business objectives into memorable human moments.',
      subline: 'The Company Behind Our Success',
    },
    direct: {
      eyebrow: 'What we direct',
      heading: 'Formats we shape, end to end.',
      items: [
        { title: 'Corporate Events', desc: 'Internal launches, anniversaries, town halls, leadership moments.' },
        { title: 'Brand Experiences', desc: 'Product launches, activations, media moments, consumer engagement.' },
        { title: 'Executive Gatherings', desc: 'Intimate dinners, stakeholder sessions, premium hospitality.' },
        { title: 'Experience Systems', desc: 'Concept, planning, vendor management, production, and post-event reporting.' },
      ],
    },
    testimonials: {
      heading: 'Client Testimonials',
      items: [
        {
          quote:
            'They completely nailed the atmosphere. From the music to the lighting, every single detail clicked — our partners haven’t stopped talking about it since.',
          author: 'Company Name',
        },
        {
          quote:
            'Oscenia didn’t just execute our annual gala, they crafted an immersive journey that completely elevated our brand’s presence. The attention to detail and atmosphere were simply unmatched.',
          author: 'Company Name',
        },
        {
          quote:
            'They completely nailed the atmosphere. From the music to the lighting, every single detail clicked — our partners haven’t stopped talking about it since.',
          author: 'Company Name',
        },
      ],
    },
    about: {
      eyebrow: 'About Us',
      title: 'About Us',
      intro:
        'Oscenia was created from the belief that a powerful event is a business tool and an emotional memory at the same time. We shape atmosphere, narrative, and operational flow so every audience leaves with a clear feeling and every brand leaves with a story worth telling.',
      name: {
        stylized: 'OS · CEN · IA',
        body: [
          'The name combines the sense of the ocean — scale, flow, depth, and limitless possibility — with an intentionally designed moment where stories come to life.',
          'It conveys an experience company that is expansive in vision, fluid in execution, elegant in expression, immersive in design, and memorable in impact.',
        ],
      },
      standsFor: {
        pre: 'What ',
        brand: 'Oscenia',
        post: ' stands for',
        intro:
          'Oscenia Events is a strategic event and experience company that turns business goals into polished, story-led, sensory experiences.',
        pillars: [
          { title: 'Scale', desc: 'Built for brands, teams, and experiences that can grow across formats and markets.' },
          { title: 'Flow', desc: 'Seamless guest journeys, disciplined planning, and elegant transitions from site to execution.' },
          { title: 'Memory', desc: 'Experiences designed to be felt, remembered, and retold by audiences and brands.' },
        ],
      },
      vision: {
        eyebrow: 'Our Vision',
        text: 'We exist to create experiences that people remember and stories that brands are proud to tell.',
      },
      why: {
        pre: 'Why',
        brand: 'Oscenia',
        body: [
          'Oscenia transforms business objectives into memorable human experiences through strategy, storytelling, sensory creativity, and seamless execution.',
          'We are positioned as an experience company, not a one-off event vendor. The model can expand through repeatable frameworks, partner networks, and premium client relationships.',
        ],
      },
      value: {
        heading: 'Our Value',
        items: [
          {
            title: 'Strategic Experience Design',
            body: [
              { label: 'Instead of starting with', text: '“What event do you want?”' },
              { label: 'We start with', text: '“What impact do you want to create?”' },
            ],
          },
          {
            title: 'Integrated Event Management',
            lead: 'We become a single strategic partner managing:',
            list: ['Concept Development', 'Planning', 'Production', 'Vendor Ecosystem', 'Execution', 'Post-event Evaluation'],
          },
          {
            title: 'Narrative-Driven Approach',
            lead: 'Every event has a story. We create:',
            formula: 'Purpose → Experience → Emotion → Memory',
            note: 'Because people remember how an experience made them feel, not only what happened.',
          },
        ],
      },
    },
    services: {
      eyebrow: 'Portfolio & Clients',
      heading: 'Corporate events and product launches we’ve directed.',
      // Titles align by index with PORTFOLIO in site.js
      portfolio: [
        'Lamborghini Car Launch',
        'Team Moments',
        'Coca-Cola Activation',
        'Meta Experience',
        'Netflix TUDUM',
        'Unilever Summit',
        'TikTok Stage',
        'Google Keynote',
        'H&M Launch',
      ],
      featured: {
        title: 'Lamborghini Car Launch',
        desc: 'Short introduction / explanation about the event and also the impact of the event.',
      },
      // Opened by clicking a portfolio tile. `desc` is placeholder copy until
      // the real event write-ups arrive — one per project.
      caseStudy: {
        eventTypeLabel: 'Event type',
        desc: 'Short introduction / explanation about the event and also the impact of the event.',
        galleryLabel: 'From the event',
        viewProject: 'View project',
      },
    },
    contact: {
      heading: 'Tell us what you’re building.',
      intro:
        'Share the shape of the engagement and our directors will return a first read on scope, timeline, and investment within two business days.',
      labels: {
        name: 'Your Name',
        company: 'Company',
        phone: 'Phone Number',
        eventType: 'Event Type',
        selectPlaceholder: 'Select an event type',
        guests: 'Estimated Guests',
        date: 'Estimated Date',
        more: 'Tell Us More',
      },
      eventTypes: [
        'Corporate Event',
        'Brand Experience / Product Launch',
        'Executive Gathering',
        'Gala / Award Night',
        'Conference / Summit',
        'Other',
      ],
      mailSubject: 'New event inquiry — Oscenia',
      mailFields: {
        name: 'Name',
        company: 'Company',
        phone: 'Phone',
        eventType: 'Event Type',
        guests: 'Estimated Guests',
        date: 'Estimated Date',
      },
      office: { heading: 'Our Office' },
    },
    footer: {
      seeMore: 'See More',
      followAlong: 'Follow Along',
      contactUs: 'Contact Us',
      whatsapp: 'Whatsapp',
      email: 'Email',
      copyright: '© 2026 Oscenia Event Atelier',
    },
    notFound: {
      code: '404',
      title: 'Page not found',
      body: 'The page you’re looking for has moved or no longer exists.',
      back: 'Back Home',
    },
  },

  id: {
    langName: 'Bahasa Indonesia',
    nav: { home: 'Beranda', about: 'Tentang Kami', service: 'Layanan', services: 'Layanan', contact: 'Kontak' },
    common: {
      startEvent: 'Mulai Acara Anda',
      exploreMore: 'Selengkapnya',
      sendInquiry: 'Kirim Permintaan',
      sendingInquiry: 'Membuka email Anda…',
      location: 'Lokasi',
      brandTag: 'EVENTS',
      close: 'Tutup',
      chatWithUs: 'Hubungi kami',
      talkFurther: 'Mari Bicara Lebih Lanjut',
    },
    intro: {
      clickLogo: 'klik logo untuk mulai',
      knowMore: 'Klik Untuk Merasakan',
      skip: 'Lewati',
      skipAd: 'Klik untuk Lewati',
      close: 'Tutup',
      showreelLabel: 'Showreel Oscenia',
    },
    hero: {
      headline: [
        ['Acara strategis', '&', 'imersif'],
        ['pengalaman yang', 'mengubah', 'tujuan bisnis'],
        ['menjadi', 'momen', 'manusiawi', 'tak terlupakan.'],
      ],
      tagline:
        'Acara strategis dan pengalaman imersif yang mengubah tujuan bisnis menjadi momen manusiawi yang tak terlupakan.',
      subline: 'Perusahaan di Balik Kesuksesan Kami',
    },
    direct: {
      eyebrow: 'Yang Kami Arahkan',
      heading: 'Format yang kami rancang, dari awal hingga akhir.',
      items: [
        { title: 'Acara Korporat', desc: 'Peluncuran internal, perayaan, town hall, momen kepemimpinan.' },
        { title: 'Pengalaman Merek', desc: 'Peluncuran produk, aktivasi, momen media, keterlibatan konsumen.' },
        { title: 'Pertemuan Eksekutif', desc: 'Jamuan makan malam eksklusif, sesi pemangku kepentingan, keramahan premium.' },
        { title: 'Sistem Pengalaman', desc: 'Konsep, perencanaan, manajemen vendor, produksi, dan pelaporan pasca-acara.' },
      ],
    },
    testimonials: {
      heading: 'Testimoni Klien',
      items: [
        {
          quote:
            'Mereka benar-benar menciptakan atmosfer yang sempurna. Dari musik hingga pencahayaan, setiap detail terasa pas — mitra kami tak henti membicarakannya sejak saat itu.',
          author: 'Nama Perusahaan',
        },
        {
          quote:
            'Oscenia tidak sekadar menyelenggarakan gala tahunan kami, mereka merancang perjalanan imersif yang benar-benar mengangkat kehadiran merek kami. Perhatian pada detail dan atmosfernya sungguh tak tertandingi.',
          author: 'Nama Perusahaan',
        },
        {
          quote:
            'Mereka benar-benar menciptakan atmosfer yang sempurna. Dari musik hingga pencahayaan, setiap detail terasa pas — mitra kami tak henti membicarakannya sejak saat itu.',
          author: 'Nama Perusahaan',
        },
      ],
    },
    about: {
      eyebrow: 'Tentang Kami',
      title: 'Tentang Kami',
      intro:
        'Oscenia lahir dari keyakinan bahwa acara yang berdampak adalah alat bisnis sekaligus kenangan emosional pada saat yang sama. Kami merancang atmosfer, narasi, dan alur operasional agar setiap audiens pulang dengan perasaan yang jelas dan setiap merek pulang dengan kisah yang layak diceritakan.',
      name: {
        stylized: 'OS · CEN · IA',
        body: [
          'Nama ini memadukan kesan samudra — skala, aliran, kedalaman, dan kemungkinan tanpa batas — dengan momen yang dirancang khusus tempat kisah-kisah menjadi hidup.',
          'Ia menggambarkan perusahaan pengalaman yang luas dalam visi, luwes dalam eksekusi, elegan dalam ekspresi, imersif dalam desain, dan berkesan dalam dampak.',
        ],
      },
      standsFor: {
        pre: 'Makna di balik ',
        brand: 'Oscenia',
        post: '',
        intro:
          'Oscenia Events adalah perusahaan acara dan pengalaman strategis yang mengubah tujuan bisnis menjadi pengalaman sensorik yang matang dan digerakkan oleh cerita.',
        pillars: [
          { title: 'Skala', desc: 'Dibangun untuk merek, tim, dan pengalaman yang dapat berkembang lintas format dan pasar.' },
          { title: 'Aliran', desc: 'Perjalanan tamu yang mulus, perencanaan yang disiplin, dan transisi elegan dari lokasi hingga eksekusi.' },
          { title: 'Kenangan', desc: 'Pengalaman yang dirancang untuk dirasakan, dikenang, dan diceritakan kembali oleh audiens dan merek.' },
        ],
      },
      vision: {
        eyebrow: 'Visi Kami',
        text: 'Kami hadir untuk menciptakan pengalaman yang dikenang orang dan kisah yang bangga diceritakan oleh merek.',
      },
      why: {
        pre: 'Mengapa',
        brand: 'Oscenia',
        body: [
          'Oscenia mengubah tujuan bisnis menjadi pengalaman manusiawi yang berkesan melalui strategi, penceritaan, kreativitas sensorik, dan eksekusi yang mulus.',
          'Kami memposisikan diri sebagai perusahaan pengalaman, bukan vendor acara sekali pakai. Model kami dapat berkembang melalui kerangka kerja yang dapat diulang, jaringan mitra, dan hubungan klien premium.',
        ],
      },
      value: {
        heading: 'Nilai Kami',
        items: [
          {
            title: 'Desain Pengalaman Strategis',
            body: [
              { label: 'Alih-alih memulai dengan', text: '“Acara seperti apa yang Anda inginkan?”' },
              { label: 'Kami memulai dengan', text: '“Dampak apa yang ingin Anda ciptakan?”' },
            ],
          },
          {
            title: 'Manajemen Acara Terpadu',
            lead: 'Kami menjadi satu mitra strategis yang mengelola:',
            list: ['Pengembangan Konsep', 'Perencanaan', 'Produksi', 'Ekosistem Vendor', 'Eksekusi', 'Evaluasi Pasca-acara'],
          },
          {
            title: 'Pendekatan Berbasis Narasi',
            lead: 'Setiap acara memiliki cerita. Kami menciptakan:',
            formula: 'Tujuan → Pengalaman → Emosi → Kenangan',
            note: 'Karena orang mengingat bagaimana sebuah pengalaman membuat mereka merasa, bukan hanya apa yang terjadi.',
          },
        ],
      },
    },
    services: {
      eyebrow: 'Portofolio & Klien',
      heading: 'Acara korporat dan peluncuran produk yang telah kami arahkan.',
      portfolio: [
        'Peluncuran Mobil Lamborghini',
        'Momen Tim',
        'Aktivasi Coca-Cola',
        'Pengalaman Meta',
        'Netflix TUDUM',
        'Summit Unilever',
        'Panggung TikTok',
        'Google Keynote',
        'Peluncuran H&M',
      ],
      featured: {
        title: 'Peluncuran Mobil Lamborghini',
        desc: 'Pengantar / penjelasan singkat tentang acara dan juga dampak dari acara tersebut.',
      },
      caseStudy: {
        eventTypeLabel: 'Jenis acara',
        desc: 'Pengantar / penjelasan singkat tentang acara dan juga dampak dari acara tersebut.',
        galleryLabel: 'Dari acara',
        viewProject: 'Lihat proyek',
      },
    },
    contact: {
      heading: 'Ceritakan apa yang Anda bangun.',
      intro:
        'Bagikan gambaran kerja samanya dan direktur kami akan memberikan penilaian awal mengenai ruang lingkup, linimasa, dan investasi dalam dua hari kerja.',
      labels: {
        name: 'Nama Anda',
        company: 'Perusahaan',
        phone: 'Nomor Telepon',
        eventType: 'Jenis Acara',
        selectPlaceholder: 'Pilih jenis acara',
        guests: 'Perkiraan Tamu',
        date: 'Perkiraan Tanggal',
        more: 'Ceritakan Lebih Lanjut',
      },
      eventTypes: [
        'Acara Korporat',
        'Pengalaman Merek / Peluncuran Produk',
        'Pertemuan Eksekutif',
        'Gala / Malam Penghargaan',
        'Konferensi / Summit',
        'Lainnya',
      ],
      mailSubject: 'Permintaan acara baru — Oscenia',
      mailFields: {
        name: 'Nama',
        company: 'Perusahaan',
        phone: 'Telepon',
        eventType: 'Jenis Acara',
        guests: 'Perkiraan Tamu',
        date: 'Perkiraan Tanggal',
      },
      office: { heading: 'Kantor Kami' },
    },
    footer: {
      seeMore: 'Selengkapnya',
      followAlong: 'Ikuti Kami',
      contactUs: 'Kontak',
      whatsapp: 'Whatsapp',
      email: 'Email',
      copyright: '© 2026 Oscenia Event Atelier',
    },
    notFound: {
      code: '404',
      title: 'Halaman tidak ditemukan',
      body: 'Halaman yang Anda cari telah dipindahkan atau tidak lagi tersedia.',
      back: 'Kembali ke Beranda',
    },
  },
}

export const LANGS = [
  { code: 'en', short: 'EN' },
  { code: 'id', short: 'ID' },
]
