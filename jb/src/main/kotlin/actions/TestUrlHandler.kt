package com.codestream.actions

import com.codestream.DEBUG
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.JBProtocolCommand
import com.intellij.openapi.application.JetBrainsProtocolHandler
import com.intellij.openapi.project.DumbAwareAction

class TestUrlHandler : DumbAwareAction() {

    override fun update(e: AnActionEvent) {
        e.presentation.isVisible = DEBUG
    }

    override fun actionPerformed(e: AnActionEvent) {
        // JetBrainsProtocolHandler.processJetBrainsLauncherParameters("jetbrains://idea/codestream/newrelic/errorsinbox?1=1&errorGroupGuid=MXxFUlR8RVJSX0dST1VQfDMxMThlMjRkLTc3ZDMtMzJlNy05MWQyLTkyMmFjNjBiN2M0OA&traceId=7febfd9d-29ed-11ec-9f5b-0242ac11000f_1030_3622&src=NR-errorsinbox&entityId=MXxBUE18QVBQTElDQVRJT058Mjc5NzAwMw&commit=null&remote=https://source.datanerd.us/distributed-tracing/distributed_tracing_service.git&tag=null&controller=newrelic&action=errorsinbox");
        JetBrainsProtocolHandler.processJetBrainsLauncherParameters("jetbrains://idea/codestream/newrelic/errorsinbox?1=1&errorGroupGuid=MXxFUlR8RVJSX0dST1VQfDMxMThlMjRkLTc3ZDMtMzJlNy05MWQyLTkyMmFjNjBiN2M0OA&traceId=7febfd9d-29ed-11ec-9f5b-0242ac11000f_1030_3622&src=NR-errorsinbox&entityId=MXxBUE18QVBQTElDQVRJT058Mjc5NzAwMw&commit=123c8092393aa8085320fbea2315cfe1b8d076d5&remote=https://source.datanerd.us/distributed-tracing/distributed_tracing_service.git&tag=null&controller=newrelic&action=errorsinbox");
        JBProtocolCommand.handleCurrentCommand()
    }
}
