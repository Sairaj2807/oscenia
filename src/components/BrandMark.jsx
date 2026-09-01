import { Link } from 'react-router-dom'

// The supplied brand lockups, used as-is rather than rebuilt in markup:
// public/brand/mark-*-gold.svg are verbatim copies of the vector pack's
// "Logo Vector_All Gold_No Background" (horizontal) and "_2" (stacked) files.
const SRC = {
  horizontal: '/brand/mark-horizontal-gold.svg',
  stacked: '/brand/mark-stacked-gold.svg',
}

export default function BrandMark({
  variant = 'horizontal',
  className = 'h-9',
  to = '/',
  onClick,
  as = 'link',
}) {
  const img = (
    <img
      src={SRC[variant]}
      alt="Oscenia Events"
      className={`w-auto ${className}`}
      draggable="false"
    />
  )

  if (as === 'plain') return img

  return (
    <Link to={to} onClick={onClick} className="inline-flex items-center" aria-label="Oscenia Events — home">
      {img}
    </Link>
  )
}
