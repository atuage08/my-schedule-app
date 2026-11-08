$ErrorActionPreference = 'Stop'
# Read-only helper. No execution-policy bypass, filesystem writes, or network access.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class LockedSource {
    const uint ReadAttributes=0x80, GenericRead=0x80000000, OpenExisting=3;
    const uint OpenReparse=0x00200000, BackupSemantics=0x02000000;
    const uint DirectoryAttribute=0x10, ReparseAttribute=0x400;
    const int MaxBytes=8*1024*1024;
    [StructLayout(LayoutKind.Sequential)]
    struct Info {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFileW(string name,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle,out Info info);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern uint GetFileType(SafeFileHandle handle);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetFileInformationByHandleEx(SafeFileHandle handle,int kind,IntPtr buffer,uint size);
    [StructLayout(LayoutKind.Sequential)]
    struct UnicodeString { public ushort Length,MaximumLength; public IntPtr Buffer; }
    [StructLayout(LayoutKind.Sequential)]
    struct ObjectAttributes { public uint Length; public IntPtr RootDirectory,ObjectName; public uint Attributes; public IntPtr SecurityDescriptor,SecurityQualityOfService; }
    [StructLayout(LayoutKind.Sequential)]
    struct IoStatus { public IntPtr Status; public UIntPtr Information; }
    [DllImport("ntdll.dll")]
    static extern int NtCreateFile(out SafeFileHandle handle,uint access,ref ObjectAttributes attributes,out IoStatus status,IntPtr allocation,uint fileAttributes,uint share,uint disposition,uint options,IntPtr ea,uint eaLength);

    static Info Inspect(SafeFileHandle handle,bool directory) {
        Info info;
        if(handle.IsInvalid || !GetFileInformationByHandle(handle,out info)) throw new IOException("Cannot open source safely");
        if((info.Attributes & ReparseAttribute)!=0 || GetFileType(handle)!=1 || ((info.Attributes & DirectoryAttribute)!=0)!=directory) throw new IOException("Links and non-regular sources are forbidden");
        if(!directory && (info.Links!=1 || (((ulong)info.SizeHigh<<32)|info.SizeLow)>MaxBytes)) throw new IOException("Linked or oversized source refused");
        return info;
    }
    static SafeFileHandle Volume(string path,List<SafeFileHandle> held) {
        SafeFileHandle handle=CreateFileW("\\\\?\\"+path,ReadAttributes,1,IntPtr.Zero,OpenExisting,OpenReparse|BackupSemantics,IntPtr.Zero);
        held.Add(handle);Inspect(handle,true);return handle;
    }
    static SafeFileHandle Child(SafeFileHandle parent,string part,bool directory,List<SafeFileHandle> held) {
        // Open a single component relative to the fixed parent HANDLE. A pathname
        // race/renamed ancestor cannot redirect this operation to another directory.
        IntPtr text=Marshal.StringToHGlobalUni(part), name=IntPtr.Zero;
        try {
            UnicodeString unicode=new UnicodeString {Length=(ushort)(part.Length*2),MaximumLength=(ushort)((part.Length+1)*2),Buffer=text};
            name=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));Marshal.StructureToPtr(unicode,name,false);
            ObjectAttributes attributes=new ObjectAttributes {Length=(uint)Marshal.SizeOf(typeof(ObjectAttributes)),RootDirectory=parent.DangerousGetHandle(),ObjectName=name,Attributes=0x1040}; // OBJ_DONT_REPARSE | CASE_INSENSITIVE
            IoStatus io;SafeFileHandle handle;
            int status=NtCreateFile(out handle,0x100081,ref attributes,out io,IntPtr.Zero,0,1,1,0x200020u|(directory?1u:0x40u),IntPtr.Zero,0);
            if(handle!=null)held.Add(handle);
            if(status<0)throw new IOException("Relative no-follow source open refused");
            Inspect(handle,directory);return handle;
        } finally {if(name!=IntPtr.Zero)Marshal.FreeHGlobal(name);Marshal.FreeHGlobal(text);}
    }
    static object Entries(SafeFileHandle directory) {
        List<Dictionary<string,string>> result=new List<Dictionary<string,string>>();
        IntPtr buffer=Marshal.AllocHGlobal(65536);bool restart=true;
        try {
            while(true){
                if(!GetFileInformationByHandleEx(directory,restart?15:14,buffer,65536)){
                    if(Marshal.GetLastWin32Error()==18)break;
                    throw new IOException("Protected directory enumeration failed");
                }
                restart=false;int offset=0;
                while(true){
                    int next=Marshal.ReadInt32(buffer,offset),attributes=Marshal.ReadInt32(buffer,offset+56),length=Marshal.ReadInt32(buffer,offset+60);
                    if(length<0||length%2!=0||offset+68+length>65536)throw new IOException("Invalid directory entry");
                    string name=Marshal.PtrToStringUni(IntPtr.Add(buffer,offset+68),length/2);
                    if(name!="."&&name!=".."){
                        if(result.Count>=4096)throw new IOException("Too many source entries");
                        string kind=(attributes&ReparseAttribute)!=0?"link":(attributes&DirectoryAttribute)!=0?"directory":"file";
                        result.Add(new Dictionary<string,string>{{"name",name},{"kind",kind}});
                    }
                    if(next==0)break;
                    if(next<68||offset+next>65536-68)throw new IOException("Invalid directory offset");
                    offset+=next;
                }
            }
            return result;
        } finally {Marshal.FreeHGlobal(buffer);}
    }
    static string[] Parts(string name) {
        if(name==null || name.Length>1024 || name.Length==0 || name.StartsWith("/") || name.IndexOf('\\')>=0) throw new IOException("Invalid relative source path");
        string[] parts=name.Split('/');
        foreach(string part in parts) if(part.Length==0 || part=="." || part==".." || part.IndexOfAny(Path.GetInvalidFileNameChars())>=0 || part.EndsWith(".") || part.EndsWith(" ")) throw new IOException("Invalid source component");
        return parts;
    }
    public static object Read(string root,string name,bool listing) {
        List<SafeFileHandle> held=new List<SafeFileHandle>();
        try {
            string full=Path.GetFullPath(root), volume=Path.GetPathRoot(full);
            if(volume.Length!=3 || volume[1]!=':' || !Path.IsPathRooted(root)) throw new IOException("Only local absolute drive paths are supported");
            SafeFileHandle current=Volume(volume,held);
            foreach(string part in full.Substring(volume.Length).Split(new char[]{'\\'},StringSplitOptions.RemoveEmptyEntries))current=Child(current,part,true,held);
            string[] parts=Parts(name);
            for(int i=0;i<parts.Length-1;i++)current=Child(current,parts[i],true,held);
            SafeFileHandle leaf=Child(current,parts[parts.Length-1],listing,held);
            if(listing){
                return Entries(leaf);
            }
            using(FileStream stream=new FileStream(leaf,FileAccess.Read)){
                using(MemoryStream result=new MemoryStream()){
                    byte[] buffer=new byte[65536]; int count;
                    while((count=stream.Read(buffer,0,buffer.Length))!=0){if(result.Length+count>MaxBytes)throw new IOException("Source grew beyond limit");result.Write(buffer,0,count);}
                    return Convert.ToBase64String(result.ToArray());
                }
            }
        } finally {for(int i=held.Count-1;i>=0;i--)if(held[i]!=null)held[i].Dispose();}
    }
}
'@
while ($null -ne ($line = [Console]::ReadLine())) {
    try {
        $request = $line | ConvertFrom-Json
        $data = [LockedSource]::Read([string]$request.root, [string]$request.name, ($request.operation -eq 'list'))
        $response = @{ id=$request.id; ok=$true; data=$data }
    } catch {
        $response = @{ id=$request.id; ok=$false; error='Source path, link, file type or sharing protection refused the operation' }
    }
    [Console]::WriteLine(($response | ConvertTo-Json -Depth 5 -Compress))
}
