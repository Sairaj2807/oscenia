// What a screen that works on a project shows before there is one.
//
// A new installation starts with no projects, and these screens read `projects[0]`. With seed data
// there was always one, so nothing ever rendered without it; a real, empty database crashed them.
// A project exists once a quotation is accepted and its down payment confirmed (Finance).

import { Link } from 'react-router-dom'
import { PageHeader } from './ui'
import { useT } from '../i18n'

export default function NoProjectsYet({ eyebrow, title }) {
  const t = useT()
  return (
    <div className="animate-fade-up">
      <PageHeader eyebrow={eyebrow} title={title} />
      <div className="card p-10 text-center">
        <div className="font-display text-xl text-white">{t('No projects yet')}</div>
        <p className="mx-auto mt-2 max-w-md text-sm text-white/50">
          {t('This screen works on a project. One appears once a quotation is accepted and its down payment is confirmed.')}
        </p>
        <Link to="/quotations" className="btn-gold mt-6 inline-flex">{t('Go to Quotations')}</Link>
      </div>
    </div>
  )
}
