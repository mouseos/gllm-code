import { VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { useTranslation } from "react-i18next"
import Section from "../Section"

interface AboutSectionProps {
	version: string
	renderSectionHeader: (tabId: string) => JSX.Element | null
}
const AboutSection = ({ version, renderSectionHeader }: AboutSectionProps) => {
	const { t } = useTranslation()
	return (
		<div>
			{renderSectionHeader("about")}
			<Section>
				<div className="flex px-4 flex-col gap-2">
					<h2 className="text-lg font-semibold">{t("about.version", { version })}</h2>
					<p>{t("about.description")}</p>

					<h3 className="text-md font-semibold">{t("about.community_support")}</h3>
					<p>
						<VSCodeLink href="https://x.com/cline">X</VSCodeLink>
						{" • "}
						<VSCodeLink href="https://discord.gg/cline">Discord</VSCodeLink>
						{" • "}
						<VSCodeLink href="https://www.reddit.com/r/cline/"> r/cline</VSCodeLink>
					</p>

					<h3 className="text-md font-semibold">{t("about.development")}</h3>
					<p>
						<VSCodeLink href="https://github.com/mouseos/gllm-code">GitHub</VSCodeLink>
						{" • "}
						<VSCodeLink href="https://github.com/mouseos/gllm-code/issues"> Issues</VSCodeLink>
					</p>

					<h3 className="text-md font-semibold">{t("about.resources")}</h3>
					<p>
						<VSCodeLink href="https://docs.cline.bot/">Documentation</VSCodeLink>
					</p>
				</div>
			</Section>
		</div>
	)
}

export default AboutSection
