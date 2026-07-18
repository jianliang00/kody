import { Download, Image as ImageIcon, LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { Artifact } from '@shared/protocol'

interface ArtifactCardProps {
  artifact: Artifact
  onLoad: (artifactId: string) => Promise<string>
}

export function ArtifactCard({ artifact, onLoad }: ArtifactCardProps) {
  const [source, setSource] = useState<string>()
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setSource(undefined)
    setError('')
    void onLoad(artifact.id)
      .then((value) => {
        if (!cancelled) setSource(value)
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : 'Could not load this image.')
        }
      })
    return () => {
      cancelled = true
    }
  }, [artifact.id, onLoad])

  return (
    <figure className="artifact-card">
      <div className="artifact-card__preview">
        {source ? (
          <img src={source} alt={artifact.prompt || artifact.file_name} />
        ) : error ? (
          <div className="artifact-card__error" role="alert"><ImageIcon aria-hidden="true" size={22} /> {error}</div>
        ) : (
          <div className="artifact-card__loading" role="status">
            <LoaderCircle className="spin" aria-hidden="true" size={22} /> Loading image…
          </div>
        )}
      </div>
      <figcaption>
        <span>
          <strong>{artifact.file_name}</strong>
          <small>{artifact.provider} · {artifact.model}</small>
        </span>
        {source ? (
          <a className="artifact-card__download" href={source} download={artifact.file_name}>
            <Download aria-hidden="true" size={15} /> Download
          </a>
        ) : null}
      </figcaption>
    </figure>
  )
}

export function ArtifactGallery({
  artifacts,
  onLoad
}: {
  artifacts: Artifact[]
  onLoad: (artifactId: string) => Promise<string>
}) {
  if (artifacts.length === 0) return null
  return (
    <div className="artifact-gallery">
      {artifacts.map((artifact) => (
        <ArtifactCard artifact={artifact} onLoad={onLoad} key={artifact.id} />
      ))}
    </div>
  )
}
