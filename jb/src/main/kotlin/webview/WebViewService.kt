package com.codestream.webview

import com.codestream.WEBVIEW_PATH
import com.codestream.agentService
import com.codestream.gson
import com.codestream.protocols.agent.TelemetryParams
import com.codestream.protocols.webview.WebViewNotification
import com.codestream.settings.ApplicationSettingsService
import com.codestream.settingsService
import com.github.salomonbrys.kotson.jsonObject
import com.google.gson.JsonElement
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.ServiceManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import org.apache.commons.io.FileUtils
import java.io.File
import java.nio.charset.Charset
import javax.swing.UIManager

class WebViewService(val project: Project) : Disposable {
    private val utf8 = Charset.forName("UTF-8")
    private val logger = Logger.getInstance(WebViewService::class.java)
    private val router = WebViewRouter(project)
    private lateinit var tempDir: File
    private lateinit var extractedHtmlFile: File

    val webView = createWebView(router)

    private val htmlFile: File get() = if (WEBVIEW_PATH != null) {
        File(WEBVIEW_PATH)
    } else {
        extractedHtmlFile
    }

    init {
        logger.info("Initializing WebViewService for project ${project.basePath}")
        extractAssets()
        applyStylesheet()

        UIManager.addPropertyChangeListener {
            if (it.propertyName == "lookAndFeel") {
                applyStylesheet()
                webView.loadUrl(htmlFile.url)
            }
        }
    }

    fun onDidInitialize(cb: () -> Unit) {
        if (router.initialization.isDone) cb()
        else router.initialization.thenRun(cb)
    }

    fun load(resetContext: Boolean = false) {
        logger.info("Loading WebView")
        if (resetContext) {
            project.settingsService?.clearWebViewContext()
        }
        applyStylesheet()
        webView.loadUrl(htmlFile.url)
    }

    private fun extractAssets() {
        tempDir = createTempDir("codestream")
        logger.info("Extracting webview to ${tempDir.absolutePath}")
        tempDir.deleteOnExit()
        extractedHtmlFile = File(tempDir, "webview.html")

        FileUtils.copyToFile(javaClass.getResourceAsStream("/webview/webview.js"), File(tempDir, "webview.js"))
        FileUtils.copyToFile(
            javaClass.getResourceAsStream("/webview/webview-data.js"),
            File(tempDir, "webview-data.js")
        )
        FileUtils.copyToFile(javaClass.getResourceAsStream("/webview/webview.css"), File(tempDir, "webview.css"))
        FileUtils.copyToFile(javaClass.getResourceAsStream("/webview/webview.html"), File(tempDir, "webview.html"))
    }

    private fun applyStylesheet() {
        val theme = WebViewTheme.build()
        val htmlContent = FileUtils.readFileToString(htmlFile, utf8)
            .replace("{bodyClass}", theme.name)
            .replace("<style id=\"theme\"></style>", "<style id=\"theme\">${theme.stylesheet}</style>")
        FileUtils.write(htmlFile, htmlContent, utf8)
    }

    fun postResponse(id: String, params: Any?, error: String? = null) {
        val message = jsonObject(
            "id" to id,
            "params" to gson.toJsonTree(params),
            "error" to error
        )
        postMessage(message, true)
    }

    fun postNotification(notification: WebViewNotification, force: Boolean? = false) {
        logger.debug("Posting ${notification.getMethod()}")
        val message = jsonObject(
            "method" to notification.getMethod(),
            "params" to gson.toJsonTree(notification)
        )
        postMessage(message, force)
    }

    fun postNotification(method: String, params: Any?, force: Boolean? = false) {
        logger.debug("Posting $method")
        val message = jsonObject(
            "method" to method,
            "params" to gson.toJsonTree(params)
        )
        postMessage(message, force)
    }

    private fun postMessage(message: JsonElement, force: Boolean? = false) {
        if (router.isReady || force == true) webView.postMessage(message)
    }

    override fun dispose() {
        webView.dispose()
    }

    private fun createWebView(router: WebViewRouter): WebView {
        val appSettings = ServiceManager.getService(ApplicationSettingsService::class.java)
        return try {
            if (JBCefApp.isSupported() && appSettings.jcef) {
                logger.info("JCEF enabled")
                JBCefWebView(JBCefBrowser(), router)
            } else {
                logger.info("JCEF disabled - falling back to JxBrowser")
                val engine = ServiceManager.getService(JxBrowserEngineService::class.java)
                JxBrowserWebView(engine.newBrowser(), router)
            }
        } catch (ex: Exception) {
            logger.warn("Error initializing JCEF - falling back to JxBrowser", ex)
            val engine = ServiceManager.getService(JxBrowserEngineService::class.java)
            JxBrowserWebView(engine.newBrowser(), router)
        }
    }

}

private val File.url: String
    get() = toURI().toURL().toString()
