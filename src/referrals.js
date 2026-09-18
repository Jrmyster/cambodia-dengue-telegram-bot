// Source review: 2026-09-18. Web review is not telephone verification.
// Do not replace these with fundraising offices or personal staff numbers.
export const referrals = [
  { area: 'pp', name: { en: 'National Pediatric Hospital', km: 'មន្ទីរពេទ្យកុមារជាតិ' },
    address: { en: '100 Russian Federation Boulevard, Phnom Penh', km: 'លេខ ១០០ មហាវិថីសហព័ន្ធរុស្ស៊ី ភ្នំពេញ' },
    phone: '099 761 675', type: 'hotline', historical: false,
    source: 'https://nphcambodia.info/' },
  { area: 'pp', name: { en: 'Kantha Bopha hospitals — main campus', km: 'មន្ទីរពេទ្យគន្ធបុប្ផា — ទីតាំងសំខាន់' },
    address: { en: 'Near Wat Phnom, Phnom Penh', km: 'ជិតវត្តភ្នំ ភ្នំពេញ' },
    phone: null, source: 'https://www.beat-richner.ch/kinderspitäler' },
  { area: 'sr', name: { en: 'Angkor Hospital for Children', km: 'មន្ទីរពេទ្យកុមារអង្គរ' },
    address: { en: 'Tep Vong Road & Oum Chhay Street, Svay Dangkum, Siem Reap', km: 'ផ្លូវទេពវង្ស និងផ្លូវអ៊ុំឆាយ ស្វាយដង្គំ សៀមរាប' },
    phone: '063 963 409', type: 'generalPhone', historical: false,
    source: 'https://angkorhospital.org/contact/' },
  { area: 'sr', name: { en: 'Kantha Bopha — Jayavarman VII', km: 'គន្ធបុប្ផា — ជ័យវរ្ម័នទី៧' },
    address: { en: 'Siem Reap — ask local staff for the nearest entrance', km: 'សៀមរាប — សួរបុគ្គលិកមូលដ្ឋានអំពីច្រកចូលជិតបំផុត' },
    phone: null, source: 'https://www.beat-richner.ch/kinderspitäler' },
  { area: 'bb', name: { en: 'Battambang Provincial Referral Hospital', km: 'មន្ទីរពេទ្យបង្អែកខេត្តបាត់ដំបង' },
    address: { en: 'Prek Moha Tep, Svay Por, Battambang city', km: 'ព្រែកមហាទេព ស្វាយប៉ោ ក្រុងបាត់ដំបង' },
    phone: '012 269 388', type: 'ambulancePhone', historical: true, sourceYear: 2019,
    source: 'https://www.tbcccambodia.org/images/upload/useful_information/attach_file/11-Apr-2019/LIST_OF_HEALTH_FACILITIES_SIGNED_THE_AGREEMENT.pdf' },
  { area: 'kc', name: { en: 'Kampong Cham Provincial Referral Hospital', km: 'មន្ទីរពេទ្យបង្អែកខេត្តកំពង់ចាម' },
    address: { en: 'Village 7, Kampong Cham commune, Kampong Cham city', km: 'ភូមិទី៧ សង្កាត់កំពង់ចាម ក្រុងកំពង់ចាម' },
    phone: '012 823 709', type: 'ambulancePhone', historical: true, sourceYear: 2016,
    source: 'https://www.nssf.gov.kh/wp-content/uploads/2016/09/en.pdf' },
];

export function directory(area, lang, t) {
  if (area === 'other') return { text: t.otherArea, buttons: [] };
  const entries = referrals.filter(r => r.area === area);
  const text = entries.map(r => [r.name[lang], r.address[lang],
    r.phone ? `${t[r.type]}: ${r.phone}` : t.noPhone,
    r.historical ? t.historical.replace('{year}', lang === 'km' ? String(r.sourceYear).replace(/\d/g, d => '០១២៣៤៥៦៧៨៩'[d]) : r.sourceYear) : '',
  ].filter(Boolean).join('\n')).join('\n\n');
  return { text: `${text}\n\n${t.directoryNote}`, buttons: entries.flatMap(r => [
    [{ text: `${t.map}: ${r.name[lang]}`, url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.name.en + ', ' + r.address.en)}` }],
    [{ text: `${t.sources}: ${r.name[lang]}`, url: r.source }],
  ]) };
}
