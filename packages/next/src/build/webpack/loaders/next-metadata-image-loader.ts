/*
 * This loader is responsible for extracting the metadata image info for rendering in html
 */

import type webpack from 'webpack'
import type {
  MetadataImageModule,
  PossibleImageFileNameConvention,
} from './metadata/types'
import fs from 'fs/promises'
import path from 'path'
import loaderUtils from 'next/dist/compiled/loader-utils3'
import { getImageSize } from '../../../server/image-optimizer'
import { imageExtMimeTypeMap } from '../../../lib/mime-type'
import { fileExists } from '../../../lib/file-exists'
import { WEBPACK_RESOURCE_QUERIES } from '../../../lib/constants'

interface Options {
  segment: string
  type: PossibleImageFileNameConvention
  pageExtensions: string[]
  basePath: string
}

async function nextMetadataImageLoader(this: any, content: Buffer) {
  const options: Options = this.getOptions()
  const { type, segment, pageExtensions, basePath } = options
  const numericSizes = type === 'twitter' || type === 'openGraph'
  const { resourcePath, rootContext: context } = this
  const { name: fileNameBase, ext } = path.parse(resourcePath)

  let extension = ext.slice(1)
  if (extension === 'jpg') {
    extension = 'jpeg'
  }

  const opts = { context, content }

  // No hash query for favicon.ico
  const contentHash =
    type === 'favicon'
      ? ''
      : loaderUtils.interpolateName(this, '[contenthash]', opts)

  const interpolatedName = loaderUtils.interpolateName(
    this,
    '[name].[ext]',
    opts
  )

  const isDynamicResource = pageExtensions.includes(extension)
  const pageSegment = isDynamicResource ? fileNameBase : interpolatedName
  const hashQuery = contentHash ? '?' + contentHash : ''
  const pathnamePrefix = path.join(basePath, segment)

  if (isDynamicResource) {
    const mod = await new Promise<webpack.NormalModule>((res, rej) => {
      this.loadModule(
        resourcePath,
        (err: null | Error, _source: any, _sourceMap: any, module: any) => {
          if (err) {
            return rej(err)
          }
          res(module)
        }
      )
    })

    const exportedFieldsExcludingDefault =
      mod.dependencies
        ?.filter((dep) => {
          return (
            [
              'HarmonyExportImportedSpecifierDependency',
              'HarmonyExportSpecifierDependency',
            ].includes(dep.constructor.name) &&
            'name' in dep &&
            dep.name !== 'default'
          )
        })
        .map((dep: any) => {
          return dep.name
        }) || []
    // re-export and spread as `exportedImageData` to avoid non-exported error
    return `\
    import {
      ${exportedFieldsExcludingDefault
        .map((field) => `${field} as _${field}`)
        .join(',')}
    } from ${JSON.stringify(
      // This is an arbitrary resource query to ensure it's a new request, instead
      // of sharing the same module with next-metadata-route-loader.
      // Since here we only need export fields such as `size`, `alt` and
      // `generateImageMetadata`, avoid sharing the same module can make this entry
      // smaller.
      resourcePath + '?' + WEBPACK_RESOURCE_QUERIES.metadataImageMeta
    )}
    import { fillMetadataSegment } from 'next/dist/lib/metadata/get-metadata-route'

    const imageModule = {
      ${exportedFieldsExcludingDefault
        .map((field) => `${field}: _${field}`)
        .join(',')}
    }

    export default async function (props) {
      const { __metadata_id__: _, ...params } = props.params
      const imageUrl = fillMetadataSegment(${JSON.stringify(
        pathnamePrefix
      )}, params, ${JSON.stringify(pageSegment)})

      const { generateImageMetadata } = imageModule

      function getImageMetadata(imageMetadata, idParam) {
        const data = {
          alt: imageMetadata.alt,
          type: imageMetadata.contentType || 'image/png',
          url: imageUrl + (idParam ? ('/' + idParam) : '') + ${JSON.stringify(
            hashQuery
          )},
        }
        const { size } = imageMetadata
        if (size) {
          ${
            type === 'twitter' || type === 'openGraph'
              ? 'data.width = size.width; data.height = size.height;'
              : 'data.sizes = size.width + "x" + size.height;'
          }
        }
        return data
      }

      if (generateImageMetadata) {
        const imageMetadataArray = await generateImageMetadata({ params })
        return imageMetadataArray.map((imageMetadata, index) => {
          const idParam = (imageMetadata.id || index) + ''
          return getImageMetadata(imageMetadata, idParam)
        })
      } else {
        return [getImageMetadata(imageModule, '')]
      }
    }`
  }

  const imageSize = await getImageSize(
    content,
    extension as 'avif' | 'webp' | 'png' | 'jpeg'
  ).catch((err) => err)

  if (imageSize instanceof Error) {
    const err = imageSize
    err.name = 'InvalidImageFormatError'
    throw err
  }

  const imageData: Omit<MetadataImageModule, 'url'> = {
    ...(extension in imageExtMimeTypeMap && {
      type: imageExtMimeTypeMap[extension as keyof typeof imageExtMimeTypeMap],
    }),
    ...(numericSizes
      ? { width: imageSize.width as number, height: imageSize.height as number }
      : {
          sizes:
            extension === 'ico'
              ? 'any'
              : `${imageSize.width}x${imageSize.height}`,
        }),
  }
  if (type === 'openGraph' || type === 'twitter') {
    const altPath = path.join(
      path.dirname(resourcePath),
      fileNameBase + '.alt.txt'
    )

    if (await fileExists(altPath)) {
      imageData.alt = await fs.readFile(altPath, 'utf8')
    }
  }

  return `\
  import { fillMetadataSegment } from 'next/dist/lib/metadata/get-metadata-route'

  export default (props) => {
    const imageData = ${JSON.stringify(imageData)}
    const imageUrl = fillMetadataSegment(${JSON.stringify(
      pathnamePrefix
    )}, props.params, ${JSON.stringify(pageSegment)})

    return [{
      ...imageData,
      url: imageUrl + ${JSON.stringify(type === 'favicon' ? '' : hashQuery)},
    }]
  }`
}

export const raw = true
export default nextMetadataImageLoader
